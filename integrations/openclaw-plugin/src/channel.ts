import type { ClientMessage } from '@proj-airi/openclaw-bridge/contracts'
import type { ChannelPlugin, OpenClawPluginApi } from 'openclaw/plugin-sdk/channel-core'

import type { Config } from './config'
import type { Conversation, Registry } from './registry'

import { randomUUID } from 'node:crypto'

import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from 'openclaw/plugin-sdk/approval-handler-runtime'
import { getExecApprovalReplyMetadata } from 'openclaw/plugin-sdk/approval-reply-runtime'
import { runPassiveAccountLifecycle } from 'openclaw/plugin-sdk/channel-outbound'
import { registerChannelRuntimeContext } from 'openclaw/plugin-sdk/channel-runtime-context'

import * as v from 'valibot'

import { createApprovals } from './approvals'

const accountSchema = v.optional(v.object({ enabled: v.optional(v.boolean(), true) }))

/** Connect the native channel to core ingress, session persistence, permissions, and reply delivery. */
export function createChannel(api: OpenClawPluginApi, config: Config, registry: Registry) {
  const runtime = api.runtime.channel
  let running = false

  const channel: ChannelPlugin<{ accountId: string, enabled: boolean }> = {
    id: 'airi',
    meta: {
      id: 'airi',
      label: 'AIRI',
      selectionLabel: 'AIRI Agent Mode',
      docsPath: '/channels/airi',
      blurb: 'Talk to an OpenClaw agent through AIRI.',
    },
    capabilities: { chatTypes: ['direct'], blockStreaming: true },
    config: {
      listAccountIds: () => ['default'],
      resolveAccount: cfg => ({ accountId: 'default', enabled: v.parse(accountSchema, cfg.channels?.airi)?.enabled !== false }),
      inspectAccount: cfg => ({ accountId: 'default', enabled: v.parse(accountSchema, cfg.channels?.airi)?.enabled !== false, configured: config.clients.length > 0 }),
      isEnabled: account => account.enabled,
      isConfigured: () => config.clients.length > 0,
      resolveAllowFrom: () => config.clients.map(client => client.principalId),
    },
    status: {
      defaultRuntime: { accountId: 'default', running: false, lifecycle: 'stopped' },
      buildChannelSummary: ({ snapshot }) => ({ running: snapshot.running, lifecycle: snapshot.lifecycle, statusState: snapshot.statusState, connectedClients: registry.connectedClients(), endpoint: '/plugins/airi/v1' }),
      buildAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: true,
        running,
        lifecycle: running ? 'ready' : 'stopped',
        connected: registry.connectedClients() > 0 ? true : undefined,
        statusState: running ? (registry.connectedClients() > 0 ? 'connected' : 'listening') : 'stopped',
        stateReason: `${registry.connectedClients()} authenticated AIRI clients`,
        webhookPath: '/plugins/airi/v1',
      }),
    },
    gateway: {
      startAccount: ctx => runPassiveAccountLifecycle({
        abortSignal: ctx.abortSignal,
        start: async () => {
          if (running)
            throw new Error('The AIRI account is already running')
          const approvalContext = registerChannelRuntimeContext({
            channelRuntime: ctx.channelRuntime,
            channelId: 'airi',
            accountId: ctx.accountId,
            capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
            context: {},
            abortSignal: ctx.abortSignal,
          })
          if (!approvalContext)
            throw new Error('The host does not expose the AIRI native approval runtime context registry')
          running = true
          const update = () => ctx.setStatus({
            ...ctx.getStatus(),
            accountId: ctx.accountId,
            running: true,
            lifecycle: 'ready',
            connected: registry.connectedClients() > 0 ? true : undefined,
            statusState: registry.connectedClients() > 0 ? 'connected' : 'listening',
            stateReason: `${registry.connectedClients()} authenticated AIRI clients`,
            webhookPath: '/plugins/airi/v1',
          })
          const unsubscribe = registry.subscribeConnections(update)
          update()
          return () => {
            unsubscribe()
            approvalContext.dispose()
          }
        },
        stop: (unsubscribe) => {
          running = false
          unsubscribe()
          registry.stopConnections()
          ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, running: false, lifecycle: 'stopped', connected: undefined, statusState: 'stopped', stateReason: '0 authenticated AIRI clients' })
        },
      }),
    },
    messaging: {
      normalizeTarget: value => value.startsWith('airi:') ? value.slice(5) : value,
      inferTargetChatType: () => 'direct',
      targetResolver: { looksLikeId: value => /^(?:airi:)?[a-f0-9]{64}$/.test(value), hint: '<airi-conversation-id>' },
    },
    approvalCapability: createApprovals(config, registry, () => running),
    outbound: {
      deliveryMode: 'direct',
      sendText: async ({ to, text }) => {
        const conversation = registry.forTarget(to)
        const messageId = randomUUID()
        registry.emit(conversation, { version: 1, type: 'response.final', messageId, text })
        return { channel: 'airi', messageId, chatId: conversation.peerId }
      },
    },
    agentPrompt: {
      inboundFormattingHints: () => ({ text_markup: 'markdown', rules: [
        'AIRI is a presentation channel. Keep your own OpenClaw identity and instructions.',
        'Use airi_presentation for intentional avatar, voice, settings, and profile changes.',
        'Speak only user-facing response text. Keep presentation commands and internal metadata out of prose.',
      ] }),
    },
  }

  function sessionKey(conversation: { agentId: string }, peerId: string) {
    return runtime.routing.buildAgentSessionKey({
      agentId: conversation.agentId,
      channel: 'airi',
      accountId: 'default',
      peer: { kind: 'direct', id: peerId },
      dmScope: 'per-account-channel-peer',
    })
  }

  async function dispatch(conversation: Conversation, message: Extract<ClientMessage, { type: 'user.message' }>, controller: AbortController) {
    const cfg = api.config
    const ingress = await runtime.inbound.ingress.resolveStable({
      channelId: 'airi',
      accountId: 'default',
      cfg,
      identity: { key: 'sender', entryIdPrefix: 'airi-entry' },
      subject: { stableId: conversation.principal.principalId },
      conversation: { kind: 'direct', id: conversation.peerId },
      contextBinding: {
        agentId: conversation.agentId,
        sessionKey: conversation.sessionKey,
        messageId: message.messageId,
        inboundEventKind: 'user_request',
      },
      dmPolicy: 'allowlist',
      allowFrom: config.clients.map(client => client.principalId),
      command: { requested: true, cfg },
    })
    if (ingress.ingress.admission !== 'dispatch')
      throw new Error('OpenClaw channel policy denied the AIRI message')
    const timestamp = Date.now()
    const target = `airi:${conversation.peerId}`
    const ctxPayload = runtime.inbound.buildContext({
      channel: 'airi',
      accountId: 'default',
      messageId: message.messageId,
      timestamp,
      from: target,
      sender: { id: conversation.principal.principalId, name: conversation.principal.principalId },
      conversation: { kind: 'direct', id: conversation.peerId, label: `AIRI ${conversation.clientId}` },
      route: {
        agentId: conversation.agentId,
        dmScope: 'per-account-channel-peer',
        accountId: 'default',
        routeSessionKey: conversation.sessionKey,
        dispatchSessionKey: conversation.sessionKey,
      },
      reply: { to: target, originatingTo: target },
      message: { body: message.text, bodyForAgent: message.text, rawBody: message.text, commandBody: message.text },
      access: { commands: { authorized: ingress.commandAccess.authorized } },
      channelIngress: ingress,
    })
    let preview = ''
    let previewRevised = false
    const fragments: string[] = []
    const result = await runtime.inbound.dispatch({
      cfg,
      channel: 'airi',
      accountId: 'default',
      route: { agentId: conversation.agentId, dmScope: 'per-account-channel-peer', sessionKey: conversation.sessionKey },
      ctxPayload,
      delivery: {
        deliver: async (payload, info) => {
          if (controller.signal.aborted || payload.isReasoning || payload.isCommentary)
            return
          const approval = getExecApprovalReplyMetadata(payload)
          if (approval) {
            if (approval.sessionKey && approval.sessionKey !== conversation.sessionKey)
              throw new Error('Approval session does not match the AIRI conversation')
            registry.recordApproval(conversation, approval.approvalSlug, {
              version: 1,
              type: 'approval.request',
              approvalId: approval.approvalId,
              kind: approval.approvalKind,
              description: payload.text ?? 'OpenClaw approval required',
              allowedDecisions: [...(approval.allowedDecisions ?? ['allow-once', 'deny'])],
            })
            return
          }
          if (info.kind === 'final' && payload.text) {
            fragments.push(payload.text)
          }
        },
      },
      replyOptions: {
        runId: randomUUID(),
        abortSignal: controller.signal,
        sourceReplyDeliveryMode: 'automatic',
        suppressToolProgressMessages: true,
        onPartialReply: (payload) => {
          if (controller.signal.aborted)
            return false
          const next = payload.text ?? `${preview}${payload.delta ?? ''}`
          if (next === preview)
            return false
          const delta = next.startsWith(preview) ? next.slice(preview.length) : ''
          if (!next.startsWith(preview))
            previewRevised = true
          preview = next
          // A revision cannot retract text already shown or spoken. Stop deltas until the corrected terminal response.
          if (previewRevised || !delta)
            return false
          registry.emit(conversation, { version: 1, type: 'response.delta', messageId: message.messageId, text: delta })
          return true
        },
      },
      replyPipeline: {},
    })
    if (result.admission.kind !== 'dispatch')
      throw new Error(`OpenClaw declined the AIRI turn: ${result.admission.kind}`)
    return { text: fragments.join('\n\n'), cancelled: controller.signal.aborted }
  }

  return { channel, sessionKey, dispatch, isRunning: () => running }
}
