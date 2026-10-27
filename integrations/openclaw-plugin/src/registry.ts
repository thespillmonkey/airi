import type {
  ClientMessage,
  PresentationCapabilities,
  PresentationCommand,
  PresentationState,
  ServerMessage,
} from '@proj-airi/openclaw-bridge/contracts'

import type { Principal } from './config'

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { serverMessageSchema } from '@proj-airi/openclaw-bridge/contracts'

import * as v from 'valibot'

/** A transport owns one connection, not the durable conversation or agent identity. */
export interface Connection {
  send: (message: ServerMessage) => void
  close: () => void
}

type SequencedMessage = Extract<ServerMessage, { sequence: number }>
type WithoutSequence<T> = T extends { sequence: number } ? Omit<T, 'sequence'> : never
type Event = WithoutSequence<SequencedMessage>
export type TurnTerminal = WithoutSequence<Extract<ServerMessage, { type: 'response.final' | 'response.error' | 'response.cancelled' }>> & { messageId: string }
type PresentationResult = Extract<ClientMessage, { type: 'presentation.result' }>
type Decision = Extract<ClientMessage, { type: 'approval.resolve' }>['decision']
interface Approval { commandId: string, decisions: readonly string[], commands: readonly { decision: Decision, command: string }[], request: Extract<ServerMessage, { type: 'approval.request' }> }

interface PendingAction {
  resolve: (result: PresentationResult) => void
  reject: (error: Error) => void
  cleanup: () => void
}

/** In-memory delivery state survives socket reconnects but never substitutes for the OpenClaw session store. */
export interface Conversation {
  key: string
  peerId: string
  principal: Principal
  clientId: string
  conversationId: string
  agentId: string
  sessionKey: string
  connection?: Connection
  connectionId?: string
  capabilities?: PresentationCapabilities
  state?: PresentationState
  sequence: number
  events: SequencedMessage[]
  turns: Map<string, AbortController | null>
  actions: Map<string, PendingAction>
  approvals: Map<string, Approval>
}

/** Own connections, correlated actions, bounded replay, and exact-turn cancellation. */
export function createRegistry(storageDir?: string) {
  if (storageDir)
    mkdirSync(storageDir, { recursive: true, mode: 0o700 })
  const journalSchema = v.strictObject({
    key: v.string(),
    sessionKey: v.string(),
    sequence: v.pipe(v.number(), v.integer(), v.minValue(0)),
    events: v.pipe(v.array(serverMessageSchema), v.maxLength(256)),
    turns: v.pipe(v.array(v.strictObject({ messageId: v.string(), active: v.boolean() })), v.maxLength(256)),
    approvals: v.pipe(v.array(v.strictObject({ commandId: v.string(), decisions: v.array(v.string()), request: serverMessageSchema, commands: v.array(v.strictObject({ decision: v.picklist(['allow-once', 'allow-always', 'deny']), command: v.string() })) })), v.maxLength(32)),
  })

  function persist(conversation: Conversation) {
    if (!storageDir)
      return
    const destination = join(storageDir, `${conversation.peerId}.json`)
    const temporary = `${destination}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({
      key: conversation.key,
      sessionKey: conversation.sessionKey,
      sequence: conversation.sequence,
      events: conversation.events,
      approvals: [...conversation.approvals.values()],
      turns: [...conversation.turns].map(([messageId, controller]) => ({ messageId, active: controller !== null })),
    }), { mode: 0o600 })
    renameSync(temporary, destination)
  }

  function restore(conversation: Conversation) {
    if (!storageDir)
      return
    const destination = join(storageDir, `${conversation.peerId}.json`)
    if (!existsSync(destination))
      return
    const journal = v.parse(journalSchema, JSON.parse(readFileSync(destination, 'utf8')))
    if (journal.key !== conversation.key || journal.sessionKey !== conversation.sessionKey)
      throw new Error('AIRI journal ownership mismatch')
    for (const approval of journal.approvals) {
      if (approval.request.type !== 'approval.request')
        throw new Error('Invalid approval journal entry')
      conversation.approvals.set(approval.request.approvalId, { ...approval, request: approval.request })
    }
    conversation.sequence = journal.sequence
    conversation.events = journal.events.filter((event): event is SequencedMessage => 'sequence' in event)
    for (const turn of journal.turns) {
      conversation.turns.set(turn.messageId, null)
      if (turn.active) {
        conversation.events.push({
          version: 1,
          type: 'response.error',
          messageId: turn.messageId,
          code: 'host_restarted',
          message: 'OpenClaw restarted during this turn. Read saved history before another message.',
          sequence: ++conversation.sequence,
        })
      }
    }
    conversation.events = conversation.events.slice(-256)
    persist(conversation)
  }
  const conversations = new Map<string, Conversation>()
  let disposed = false
  const connectionObservers = new Set<() => void>()
  const submittedApprovals = new Set<string>()

  function connectedClients() {
    return [...conversations.values()].filter(conversation => conversation.connection).length
  }

  function subscribeConnections(observer: () => void) {
    connectionObservers.add(observer)
    return () => {
      connectionObservers.delete(observer)
    }
  }

  function notifyConnections() {
    for (const observer of connectionObservers)
      observer()
  }

  function appendEvent(conversation: Conversation, event: Event) {
    const message = { ...event, sequence: ++conversation.sequence } as SequencedMessage
    conversation.events.push(message)
    if (conversation.events.length > 256)
      conversation.events.shift()
    return message
  }

  function publish(conversation: Conversation, message: SequencedMessage) {
    try {
      conversation.connection?.send(message)
    }
    catch {
      if (conversation.connection)
        disconnect(conversation, conversation.connection)
    }
  }

  function emit(conversation: Conversation, event: Event) {
    const message = appendEvent(conversation, event)
    persist(conversation)
    publish(conversation, message)
  }

  function completeTurn(conversation: Conversation, terminal: TurnTerminal) {
    if (!conversation.turns.get(terminal.messageId))
      return false
    // One journal commit releases admission and records its terminal response before either becomes externally visible.
    conversation.turns.set(terminal.messageId, null)
    const idle = appendEvent(conversation, { version: 1, type: 'status', state: 'idle' })
    const message = appendEvent(conversation, terminal)
    persist(conversation)
    publish(conversation, idle)
    publish(conversation, message)
    return true
  }

  function attach(principal: Principal, hello: Extract<ClientMessage, { type: 'hello' }>, connection: Connection, sessionKeyForPeer: (peerId: string) => string) {
    if (disposed)
      throw new Error('AIRI plugin is stopped')
    if (!principal.agentIds.includes(hello.agentId))
      throw new Error('Agent is not allowed for this principal')
    const key = JSON.stringify([principal.principalId, hello.clientId, hello.conversationId, hello.agentId])
    let conversation = conversations.get(key)
    if (!conversation) {
      if (conversations.size >= 128)
        throw new Error('AIRI conversation limit reached')
      const peerId = createHash('sha256').update(key).digest('hex')
      conversation = {
        key,
        peerId,
        principal,
        clientId: hello.clientId,
        conversationId: hello.conversationId,
        agentId: hello.agentId,
        sessionKey: sessionKeyForPeer(peerId),
        sequence: 0,
        events: [],
        turns: new Map(),
        actions: new Map(),
        approvals: new Map(),
      }
      restore(conversation)
      conversations.set(key, conversation)
    }
    if (conversation.connection) {
      const previous = conversation.connection
      disconnect(conversation, previous)
      previous.close()
    }
    conversation.connection = connection
    conversation.connectionId = randomUUID()
    // Sequence gaps require explicit recovery. Replaying only a tail can lose speech or response content.
    const lastSequence = hello.lastSequence ?? 0
    const earliest = conversation.events[0]?.sequence ?? conversation.sequence + 1
    if (lastSequence > conversation.sequence || lastSequence < earliest - 1) {
      conversation.connection = undefined
      throw new Error('Replay window expired. Open the saved OpenClaw conversation before reconnecting.')
    }
    notifyConnections()
    return conversation
  }

  function replay(conversation: Conversation, after: number) {
    for (const approval of conversation.approvals.values())
      conversation.connection?.send(approval.request)
    for (const event of conversation.events) {
      if (event.sequence > after)
        conversation.connection?.send(event)
    }
  }

  function disconnect(conversation: Conversation, connection: Connection) {
    if (conversation.connection !== connection)
      return
    conversation.connection = undefined
    // Commands never migrate to a replacement socket. Their effective side effects require fresh discovery.
    for (const action of conversation.actions.values()) {
      action.cleanup()
      action.reject(new Error('AIRI client disconnected. Refresh presentation state before another change.'))
    }
    conversation.actions.clear()
    conversation.capabilities = undefined
    conversation.state = undefined
    notifyConnections()
  }

  function beginTurn(conversation: Conversation, messageId: string) {
    if (conversation.turns.has(messageId))
      return undefined
    if ([...conversation.turns.values()].some(controller => controller !== null))
      throw new Error('A response is active. Cancel it before another message.')
    if (conversation.turns.size >= 256)
      throw new Error('AIRI message deduplication limit reached. Create a new conversation.')
    const controller = new AbortController()
    conversation.turns.set(messageId, controller)
    try {
      persist(conversation)
    }
    catch (error) {
      conversation.turns.delete(messageId)
      throw error
    }
    return controller
  }

  function cancel(conversation: Conversation, messageId: string) {
    const controller = conversation.turns.get(messageId)
    if (!controller)
      return false
    controller.abort()
    return true
  }

  function finishTurn(conversation: Conversation, messageId: string) {
    conversation.turns.set(messageId, null)
    persist(conversation)
  }

  function forSession(sessionKey: string, senderId: string) {
    const conversation = [...conversations.values()].find(value => value.sessionKey === sessionKey && value.principal.principalId === senderId)
    if (!conversation?.connection)
      throw new Error('No connected AIRI client owns this session')
    return conversation
  }

  function forTarget(target: string) {
    const peerId = target.startsWith('airi:') ? target.slice(5) : target
    const conversation = [...conversations.values()].find(value => value.peerId === peerId)
    if (!conversation?.connection)
      throw new Error('AIRI conversation is disconnected')
    return conversation
  }

  function update(conversation: Conversation, capabilities: PresentationCapabilities, state: PresentationState) {
    if (conversation.state && state.revision < conversation.state.revision)
      throw new Error('Stale presentation state revision')
    conversation.capabilities = capabilities
    conversation.state = state
  }

  function acceptResult(conversation: Conversation, result: PresentationResult) {
    const pending = conversation.actions.get(result.actionId)
    if (!pending)
      return false
    conversation.actions.delete(result.actionId)
    pending.cleanup()
    if (result.state && conversation.state && result.state.revision < conversation.state.revision) {
      pending.reject(new Error('Client returned stale presentation state'))
      return false
    }
    if (result.state)
      conversation.state = result.state
    if (result.capabilities)
      conversation.capabilities = result.capabilities
    if (!result.ok)
      pending.reject(new Error(result.error ?? 'AIRI rejected the presentation command'))
    else
      pending.resolve(result)
    return true
  }

  async function request(conversation: Conversation, command: PresentationCommand, signal?: AbortSignal): Promise<PresentationResult> {
    if (!conversation.connection || disposed)
      throw new Error('AIRI client is disconnected')
    if (command.operation !== 'state.read' && (!conversation.capabilities || !conversation.state))
      throw new Error('AIRI presentation discovery is not ready. Read state before another change.')
    if (conversation.actions.size >= 16)
      throw new Error('Too many pending presentation commands')
    if (signal?.aborted)
      throw new Error('Presentation command cancelled')
    if (command.operation !== 'state.read')
      validateCommand(conversation, command)
    const actionId = randomUUID()
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        conversation.actions.delete(actionId)
        conversation.state = undefined
        conversation.capabilities = undefined
        cleanup()
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error('Presentation acknowledgement timed out. Refresh state before another change.')), 15000)
      const abort = () => fail(new Error('Presentation command cancelled. Its side effect can require state refresh.'))
      function cleanup() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      conversation.actions.set(actionId, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        conversation.connection?.send({ version: 1, type: 'presentation.request', actionId, command })
      }
      catch {
        fail(new Error('Presentation transport failed'))
      }
    })
  }

  function recordApproval(conversation: Conversation, commandId: string, request: Approval['request'], commands: Approval['commands'] = []) {
    if (conversation.approvals.size >= 32 && !conversation.approvals.has(request.approvalId))
      throw new Error('Too many pending AIRI approvals')
    conversation.approvals.set(request.approvalId, { commandId, decisions: request.allowedDecisions ?? ['allow-once', 'deny'], commands, request })
    persist(conversation)
    conversation.connection?.send(request)
  }

  function resolveApproval(conversation: Conversation, approvalId: string, decision: string) {
    const approval = conversation.approvals.get(approvalId)
    if (!approval || !approval.decisions.includes(decision) || submittedApprovals.has(approvalId))
      throw new Error('Approval is unavailable for this conversation or decision')
    submittedApprovals.add(approvalId)
    return approval.commands.find(command => command.decision === decision)?.command ?? `/approve ${approval.commandId} ${decision}`
  }

  function approvalConversation(sessionKey: string) {
    return [...conversations.values()].find(conversation => conversation.sessionKey === sessionKey)
  }

  function settleApproval(conversation: Conversation, event: WithoutSequence<Extract<ServerMessage, { type: 'approval.resolved' }>>) {
    if (!conversation.approvals.delete(event.approvalId))
      return false
    submittedApprovals.delete(event.approvalId)
    emit(conversation, event)
    return true
  }

  function stopConnections() {
    for (const conversation of conversations.values()) {
      for (const controller of conversation.turns.values())
        controller?.abort()
      if (conversation.connection) {
        const connection = conversation.connection
        disconnect(conversation, connection)
        connection.close()
      }
    }
  }

  function dispose() {
    disposed = true
    stopConnections()
    conversations.clear()
    connectionObservers.clear()
  }

  return { attach, replay, disconnect, beginTurn, cancel, finishTurn, completeTurn, forSession, forTarget, emit, update, acceptResult, request, recordApproval, resolveApproval, approvalConversation, settleApproval, connectedClients, subscribeConnections, stopConnections, dispose }
}

function validateCommand(conversation: Conversation, command: PresentationCommand) {
  const capabilities = conversation.capabilities
  if (!capabilities)
    throw new Error('Presentation capabilities are unavailable')
  // Agent and application defaults affect other conversations. This first release exposes only isolated scopes.
  if ('scope' in command && command.scope && (!['client', 'conversation'].includes(command.scope) || !capabilities.profileScopes.includes(command.scope)))
    throw new Error('The requested presentation scope is unsupported by this client')
  if (command.operation === 'avatar.select' && !capabilities.avatars.some(avatar => avatar.id === command.avatarId && avatar.available))
    throw new Error('Avatar is unavailable')
  if (command.operation === 'avatar.control' && !capabilities.activeAvatarControls.some(control => control.id === command.controlId))
    throw new Error('Avatar control is unsupported')
  if (command.operation === 'voice.select') {
    const voice = capabilities.voices.find(voice => voice.id === command.voice.voiceId && voice.providerId === command.voice.providerId && voice.modelId === command.voice.modelId)
    if (!voice)
      throw new Error('Voice is unavailable')
    for (const [key, value] of Object.entries(command.voice.parameters ?? {})) {
      const parameter = voice.parameters.find(parameter => parameter.key === key)
      if (!parameter || value < parameter.min || value > parameter.max)
        throw new Error('Voice parameter is unsupported or outside its range')
    }
  }
  if (command.operation === 'settings.update') {
    for (const [key, value] of Object.entries(command.settings)) {
      const setting = capabilities.settings.find(setting => setting.key === key)
      if (!setting?.supported)
        throw new Error(`Setting ${key} is unsupported`)
      if (typeof value === 'number' && ((setting.min !== undefined && value < setting.min) || (setting.max !== undefined && value > setting.max)))
        throw new Error(`Setting ${key} is outside its range`)
      if (setting.values && typeof value === 'string' && !setting.values.includes(value))
        throw new Error(`Setting ${key} has an invalid selection`)
    }
  }
}

export type Registry = ReturnType<typeof createRegistry>
