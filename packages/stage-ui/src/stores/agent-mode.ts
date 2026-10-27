import type { PresentationCommand, PresentationResult, ServerMessage, VoiceSelection } from '@proj-airi/openclaw-bridge'
import type {} from 'pinia-plugin-synced'

import { errorMessageFrom } from '@moeru/std'
import { OpenClawBridgeClient, voiceSelectionSchema } from '@proj-airi/openclaw-bridge'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'

import * as v from 'valibot'

import { syncedRoles } from '../libs/pinia/synced-context'

/** Local callbacks stay outside synchronized snapshots and transport payloads. */
export interface AgentModeHost {
  event: (event: ServerMessage) => Promise<void>
  stop: () => Promise<void>
  pause?: () => Promise<void>
}
export interface AgentPresentationHost {
  begin: () => Promise<void>
  restore: () => Promise<void>
  execute: (command: PresentationCommand) => Promise<PresentationResult>
}

/** Persisted Agent Mode fails closed after reload. Only explicit Normal Mode resumes local reasoning. */
export const useAgentModeStore = defineStore('openclaw-agent-mode', () => {
  const persistence = globalThis.localStorage
  const voiceCatalogSchema = v.pipe(v.array(voiceSelectionSchema), v.maxLength(256))
  let initialVoiceCatalog: VoiceSelection[] = []
  try {
    const parsed = v.safeParse(voiceCatalogSchema, JSON.parse(persistence?.getItem('openclaw/voice-catalog') ?? '[]'))
    if (parsed.success)
      initialVoiceCatalog = parsed.output
  }
  catch {}
  const configuredVoices = ref(initialVoiceCatalog)
  const mode = ref<'normal' | 'agent'>(persistence?.getItem('openclaw/mode') === 'agent' ? 'agent' : 'normal')
  const connection = ref('disconnected')
  const agentId = ref(persistence?.getItem('openclaw/agent-id') ?? '')
  const endpoint = ref(persistence?.getItem('openclaw/endpoint') ?? '')
  const clientId = ref(persistence?.getItem('openclaw/client-id') ?? crypto.randomUUID())
  persistence?.setItem('openclaw/client-id', clientId.value)
  const agents = ref<Array<{ id: string, name: string }>>([])
  const error = ref<string>()
  const approvals = ref<Array<{ id: string, description: string, allowedDecisions: Array<'allow-once' | 'allow-always' | 'deny'>, resolving?: boolean }>>([])
  const approvalFeedback = ref<'resolved' | 'expired' | 'cancelled'>()
  const active = computed(() => mode.value === 'agent')
  const ready = computed(() => active.value && connection.value === 'ready')
  let chatHost: AgentModeHost | undefined
  let presentationHost: AgentPresentationHost | undefined
  let client: OpenClawBridgeClient | undefined
  let eventQueue = Promise.resolve()
  let connectedConversation: string | undefined
  let epoch = 0

  function captureInputContext() {
    const capturedEpoch = epoch
    const conversation = connectedConversation
    const selectedMode = mode.value
    return () => epoch === capturedEpoch && connectedConversation === conversation && mode.value === selectedMode
  }

  function attachChat(host: AgentModeHost) {
    chatHost = host
  }

  async function attachPresentation(host: AgentPresentationHost) {
    presentationHost = host
    if (active.value)
      await host.begin()
    else
      await host.restore()
    return () => {
      if (presentationHost === host) {
        client?.disconnect()
        presentationHost = undefined
      }
    }
  }

  async function selectMode(next: 'normal' | 'agent') {
    if (next === mode.value)
      return
    epoch += 1
    // Gate new work before cancellation or asynchronous presentation cleanup.
    if (next === 'agent') {
      mode.value = next
      persistence?.setItem('openclaw/mode', next)
    }
    client?.disconnect()
    client = undefined
    connectedConversation = undefined
    connection.value = 'disconnected'
    approvals.value = []
    await chatHost?.stop()
    if (next === 'agent') {
      await presentationHost?.begin()
    }
    else {
      await presentationHost?.restore()
      mode.value = 'normal'
      persistence?.setItem('openclaw/mode', 'normal')
    }
  }

  async function connect(options: { url: string, token: string, agentId: string, conversationId: string }) {
    if (!active.value)
      throw new Error('Select Agent Mode before connecting')
    if (!presentationHost || !chatHost)
      throw new Error('The AIRI stage is not ready')
    epoch += 1
    const connectingEpoch = epoch
    client?.disconnect()
    endpoint.value = options.url
    agentId.value = options.agentId
    persistence?.setItem('openclaw/endpoint', endpoint.value)
    persistence?.setItem('openclaw/agent-id', agentId.value)
    error.value = undefined
    client = new OpenClawBridgeClient({
      onStateChange(state, failure) {
        if (connectingEpoch !== epoch)
          return
        connection.value = state
        error.value = failure
        if (state === 'disconnected' || state === 'error')
          void chatHost?.stop()
        else if (state === 'reconnecting')
          void chatHost?.pause?.()
      },
      onEvent(event) {
        if (connectingEpoch !== epoch || !active.value)
          return
        if (event.type === 'ready') {
          agents.value = event.agents
          agentId.value = event.agentId
        }
        if (event.type === 'approval.request')
          approvals.value = [...approvals.value.filter(item => item.id !== event.approvalId), { id: event.approvalId, description: event.description, allowedDecisions: event.allowedDecisions ?? ['deny'] }]
        if (event.type === 'approval.resolved') {
          approvals.value = approvals.value.filter(item => item.id !== event.approvalId)
          approvalFeedback.value = event.status
        }
        // Serial projection keeps speech writes ahead of finalization.
        const projection = eventQueue.then(() => connectingEpoch === epoch && active.value ? chatHost?.event(event) : undefined)
        eventQueue = projection.catch((cause: unknown) => {
          error.value = errorMessageFrom(cause) ?? 'Response projection failed'
        })
        return projection
      },
      onPresentation: command => connectingEpoch === epoch && active.value
        ? presentationHost!.execute(command)
        : Promise.resolve({ ok: false, error: 'Agent Mode connection changed' }),
    })
    connectedConversation = options.conversationId
    await client.connect({ ...options, clientId: clientId.value })
    const snapshot = await presentationHost.execute({ operation: 'state.read' })
    if (snapshot.capabilities && snapshot.state)
      client.updateCapabilities(snapshot.capabilities, snapshot.state)
  }

  function send(text: string, options: { messageId: string, conversationId: string, input: 'text' | 'voice' }) {
    if (!ready.value || !client)
      throw new Error('OpenClaw is disconnected. Agent Mode remains selected.')
    if (options.conversationId !== connectedConversation)
      throw new Error('Connect this conversation before sending. The existing conversation remains unchanged.')
    const request = client.send(text, options)
    return { accepted: request.accepted, done: request.done.then(async (text) => {
      await eventQueue
      return text
    }) }
  }

  async function setVoiceCatalog(json: string) {
    const entries = v.parse(voiceCatalogSchema, JSON.parse(json))
    configuredVoices.value = entries
    persistence?.setItem('openclaw/voice-catalog', JSON.stringify(entries))
  }

  async function pauseSpeech() {
    await chatHost?.pause?.()
  }

  async function cancel(messageId: string) {
    client?.cancel(messageId)
  }

  async function disconnect() {
    epoch += 1
    client?.disconnect()
    connection.value = 'disconnected'
    approvals.value = []
    await chatHost?.stop()
  }

  async function resolveApproval(id: string, decision: 'allow-once' | 'allow-always' | 'deny') {
    if (!client || !ready.value)
      throw new Error('OpenClaw is disconnected')
    if (!approvals.value.find(item => item.id === id)?.allowedDecisions.includes(decision))
      throw new Error('This approval decision is not available')
    client.resolveApproval(id, decision)
    approvals.value = approvals.value.map(item => item.id === id ? { ...item, resolving: true } : item)
  }

  onScopeDispose(() => client?.disconnect())
  return { captureInputContext, configuredVoices, setVoiceCatalog, mode, connection, agentId, endpoint, clientId, agents, error, approvals, approvalFeedback, active, ready, attachChat, attachPresentation, pauseSpeech, selectMode, connect, send, cancel, disconnect, resolveApproval }
}, {
  synced: {
    state: true,
    actions: {
      setVoiceCatalog: { roles: [syncedRoles.speechPlayer] },
      selectMode: { roles: [syncedRoles.speechPlayer] },
      connect: { roles: [syncedRoles.speechPlayer] },
      cancel: { roles: [syncedRoles.speechPlayer] },
      disconnect: { roles: [syncedRoles.speechPlayer] },
      resolveApproval: { roles: [syncedRoles.speechPlayer] },
    },
  },
})
