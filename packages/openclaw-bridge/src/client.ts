import type { ClientMessage, PresentationCapabilities, PresentationCommand, PresentationProfile, PresentationState, ServerMessage } from './contracts'

import { errorMessageFrom } from '@moeru/std'

import { decodeServerMessage, encodeClientMessage } from './contracts'

export type BridgeConnectionState = 'disconnected' | 'connecting' | 'ready' | 'reconnecting' | 'error'
export type ReadyMessage = Extract<ServerMessage, { type: 'ready' }>
export interface PresentationResult {
  ok: boolean
  state?: PresentationState
  capabilities?: PresentationCapabilities
  profiles?: PresentationProfile[]
  error?: string
}
export interface BridgeClientCallbacks {
  onEvent?: (event: ServerMessage) => void | Promise<void>
  onStateChange?: (state: BridgeConnectionState, error?: string) => void
  onPresentation?: (command: PresentationCommand) => Promise<PresentationResult>
}
export interface BridgeConnectOptions {
  url: string
  token: string
  clientId: string
  conversationId: string
  agentId: string
  /** The authenticated hello must complete within this interval. @default 10000 */
  timeoutMs?: number
  /** Admission can recover through reconnect and stable-ID replay within this interval. @default 30000 */
  admissionTimeoutMs?: number
  /** A turn cannot retain pending client work without a terminal response forever. @default 1800000 */
  turnTimeoutMs?: number
}
interface PendingTurn {
  message: Extract<ClientMessage, { type: 'user.message' }>
  admitted: boolean
  admissionTimer: ReturnType<typeof setTimeout>
  completionTimer: ReturnType<typeof setTimeout>
  accepted: ReturnType<typeof Promise.withResolvers<{ messageId: string, sessionKey: string }>>
  done: ReturnType<typeof Promise.withResolvers<string>>
}

/**
 * Owns one authenticated conversation transport, never local reasoning or provider credentials.
 * Reconnect preserves sequence and pending turns. Explicit disconnect rejects them and erases the token.
 * A hello binds client/conversation/agent authority. Frames cannot override that authority.
 */
export class OpenClawBridgeClient {
  private socket?: WebSocket
  private options?: BridgeConnectOptions
  private connectionState: BridgeConnectionState = 'disconnected'
  private sequence = 0
  private ready?: ReadyMessage
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempts = 0
  private generation = 0
  private turns = new Map<string, PendingTurn>()
  private actions = new Map<string, Promise<PresentationResult>>()
  private presentation?: { capabilities: PresentationCapabilities, state: PresentationState }

  constructor(private callbacks: BridgeClientCallbacks = {}) {}

  get state(): BridgeConnectionState { return this.connectionState }

  /** Connect explicitly after the user selects Agent Mode and provides a connection credential. */
  async connect(options: BridgeConnectOptions): Promise<ReadyMessage> {
    this.disconnect()
    const url = new URL(options.url)
    if (!['ws:', 'wss:'].includes(url.protocol))
      throw new Error('Bridge endpoint must use ws or wss')
    if (url.username || url.password || url.search || url.hash)
      throw new Error('Bridge credentials must not appear in the endpoint URL')
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Remote bridge connections require wss')
    this.options = { ...options }
    this.sequence = 0
    this.reconnectAttempts = 0
    return this.open(false)
  }

  /** Send typed and recognized speech through the same bound conversation. */
  send(text: string, options: { messageId: string, conversationId?: string, input: 'text' | 'voice' }): { accepted: PendingTurn['accepted']['promise'], done: Promise<string> } {
    const existing = this.turns.get(options.messageId)
    if (existing)
      return { accepted: existing.accepted.promise, done: existing.done.promise }
    if (this.connectionState !== 'ready' || !this.ready || !this.options)
      throw new Error('Agent Mode is disconnected')
    if (options.conversationId && options.conversationId !== this.options.conversationId)
      throw new Error('Message belongs to a different conversation')
    if (this.turns.size >= 32)
      throw new Error('Bridge pending turn limit reached')
    const message: PendingTurn['message'] = { version: 1, type: 'user.message', messageId: options.messageId, text, input: options.input }
    const expire = (reason: string) => {
      if (this.connectionState === 'ready') {
        try {
          this.cancel(options.messageId)
        }
        catch { /* The local timeout still settles when the transport fails during cancellation. */ }
      }
      this.rejectTurn(options.messageId, new Error(reason))
    }
    const pending: PendingTurn = {
      message,
      admitted: false,
      accepted: Promise.withResolvers(),
      done: Promise.withResolvers(),
      admissionTimer: setTimeout(expire, this.options.admissionTimeoutMs ?? 30000, 'Bridge admission timed out'),
      completionTimer: setTimeout(expire, this.options.turnTimeoutMs ?? 1800000, 'Bridge response timed out'),
    }
    // Both promises can fail during disconnect before the caller starts to await completion.
    void pending.accepted.promise.catch(() => {})
    void pending.done.promise.catch(() => {})
    this.turns.set(options.messageId, pending)
    try {
      this.emit(message)
    }
    catch (error) {
      this.rejectTurn(options.messageId, error instanceof Error ? error : new Error('Bridge submission failed'))
    }
    return { accepted: pending.accepted.promise, done: pending.done.promise }
  }

  cancel(messageId: string): void {
    this.emit({ version: 1, type: 'turn.cancel', messageId })
  }

  updateCapabilities(capabilities: PresentationCapabilities, state: PresentationState): void {
    this.presentation = { capabilities, state }
    if (this.connectionState === 'ready')
      this.emit({ version: 1, type: 'capabilities.update', capabilities, state })
  }

  resolveApproval(approvalId: string, decision: 'allow-once' | 'allow-always' | 'deny'): void {
    this.emit({ version: 1, type: 'approval.resolve', approvalId, decision })
  }

  /** Close owned transport and pending work. Mode selection remains the UI owner's state. */
  disconnect(): void {
    this.generation++
    if (this.reconnectTimer)
      clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const socket = this.socket
    if (socket?.readyState === WebSocket.OPEN) {
      for (const messageId of this.turns.keys())
        socket.send(encodeClientMessage({ version: 1, type: 'turn.cancel', messageId }))
    }
    this.socket = undefined
    socket?.close(1000, 'Client disconnected')
    this.options = undefined
    this.ready = undefined
    this.actions.clear()
    this.presentation = undefined
    this.rejectTurns(new DOMException('Bridge disconnected', 'AbortError'))
    this.setState('disconnected')
  }

  private emit(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error('Bridge socket is not ready')
    this.socket.send(encodeClientMessage(message))
  }

  private setState(state: BridgeConnectionState, error?: string): void {
    this.connectionState = state
    this.callbacks.onStateChange?.(state, error)
  }

  private open(reconnecting: boolean): Promise<ReadyMessage> {
    const options = this.options
    if (!options)
      return Promise.reject(new Error('Bridge connection settings are absent'))
    const generation = this.generation
    this.setState(reconnecting ? 'reconnecting' : 'connecting')
    const socket = new WebSocket(options.url)
    this.socket = socket
    const handshake = Promise.withResolvers<ReadyMessage>()
    const timeout = setTimeout(() => {
      handshake.reject(new Error('Bridge handshake timed out'))
      socket.close(4008, 'Handshake timeout')
    }, options.timeoutMs ?? 10000)
    const current = () => generation === this.generation && this.socket === socket
    socket.addEventListener('open', () => {
      if (!current())
        return
      this.emit({ version: 1, type: 'hello', token: options.token, clientId: options.clientId, conversationId: options.conversationId, agentId: options.agentId, lastSequence: this.sequence })
    })
    socket.addEventListener('message', (event) => {
      if (!current())
        return
      try {
        if (typeof event.data !== 'string')
          throw new Error('Bridge requires text Eventa frames')
        const message = decodeServerMessage(event.data)
        if (message.type === 'ready') {
          if (message.agentId !== options.agentId || (this.ready && this.ready.sessionKey !== message.sessionKey))
            throw new Error('Bridge changed the selected agent or conversation session')
          this.ready = message
          this.reconnectAttempts = 0
          clearTimeout(timeout)
          this.setState('ready')
          handshake.resolve(message)
          if (this.presentation)
            this.emit({ version: 1, type: 'capabilities.update', ...this.presentation })
          // A disconnect can lose the input before admission. Stable message IDs make this replay safe.
          // The server journal rejects duplicate inference when the admission acknowledgement was lost.
          for (const pending of this.turns.values()) {
            if (!pending.admitted)
              this.emit(pending.message)
          }
        }
        else if (this.connectionState !== 'ready') {
          throw new Error('Bridge sent conversation data before authentication completed')
        }
        if ('sequence' in message) {
          if (message.sequence <= this.sequence)
            return
          this.sequence = message.sequence
        }
        void this.receive(message).catch((error: unknown) => {
          if (!current())
            return
          this.setState('error', errorMessageFrom(error) ?? 'Bridge response projection failed')
          socket.close(4002, 'Bridge response projection failed')
        })
      }
      catch (error) {
        const reason = errorMessageFrom(error) ?? 'Invalid bridge event'
        handshake.reject(new Error(reason))
        this.setState('error', reason)
        socket.close(4002, 'Invalid bridge event')
      }
    })
    socket.addEventListener('error', () => {
      if (current())
        this.setState('error', 'Bridge transport error')
    })
    socket.addEventListener('close', (event) => {
      clearTimeout(timeout)
      handshake.reject(new Error('Bridge closed before readiness'))
      if (!current())
        return
      this.socket = undefined
      if ([4001, 4002, 4003, 4008].includes(event.code)) {
        this.setState('error', 'Bridge authentication or protocol failed')
        this.rejectTurns(new Error('Bridge authentication or protocol failed'))
        return
      }
      this.scheduleReconnect()
    })
    return handshake.promise
  }

  private async receive(message: ServerMessage): Promise<void> {
    const generation = this.generation
    if (message.type === 'response.accepted') {
      const pending = this.turns.get(message.messageId)
      if (pending) {
        pending.admitted = true
        clearTimeout(pending.admissionTimer)
      }
    }
    // The renderer persists transcript and drains ordered speech before a turn completes.
    // Settling done first can delete the renderer's turn while final projection is pending.
    await this.callbacks.onEvent?.(message)
    if (generation !== this.generation)
      return
    if (message.type === 'response.accepted') {
      this.turns.get(message.messageId)?.accepted.resolve({ messageId: message.messageId, sessionKey: message.sessionKey })
    }
    else if (message.type === 'response.final') {
      const turn = this.turns.get(message.messageId)
      if (turn && this.ready) {
        turn.accepted.resolve({ messageId: message.messageId, sessionKey: this.ready.sessionKey })
        turn.done.resolve(message.text)
        clearTimeout(turn.admissionTimer)
        clearTimeout(turn.completionTimer)
        this.turns.delete(message.messageId)
      }
    }
    else if (message.type === 'response.cancelled') {
      const error = new DOMException('Agent response cancelled', 'AbortError')
      this.rejectTurn(message.messageId, error)
    }
    else if (message.type === 'response.error') {
      if (message.messageId)
        this.rejectTurn(message.messageId, new Error(message.message))
      else
        this.rejectTurns(new Error(message.message))
    }
    else if (message.type === 'presentation.request') {
      let result = this.actions.get(message.actionId)
      if (!result) {
        result = this.callbacks.onPresentation
          ? this.callbacks.onPresentation(message.command)
          : Promise.resolve({ ok: false, error: 'This AIRI client has no presentation adapter' })
        result = result.catch(error => ({ ok: false, error: errorMessageFrom(error) ?? 'Presentation command failed' }))
        this.actions.set(message.actionId, result)
        if (this.actions.size > 256)
          this.actions.delete(this.actions.keys().next().value!)
      }
      void result.then((value) => {
        if (generation !== this.generation || this.connectionState !== 'ready')
          return
        if (value.state && value.capabilities)
          this.presentation = { state: value.state, capabilities: value.capabilities }
        this.emit({ version: 1, type: 'presentation.result', actionId: message.actionId, ...value })
      })
    }
  }

  private rejectTurn(messageId: string, error: Error): void {
    const turn = this.turns.get(messageId)
    if (turn) {
      clearTimeout(turn.admissionTimer)
      clearTimeout(turn.completionTimer)
      turn.accepted.reject(error)
      turn.done.reject(error)
    }
    this.turns.delete(messageId)
  }

  private rejectTurns(error: Error): void {
    for (const id of this.turns.keys())
      this.rejectTurn(id, error)
  }

  private scheduleReconnect(): void {
    if (!this.options)
      return
    if (this.reconnectAttempts >= 8) {
      this.setState('error', 'Bridge reconnect limit reached')
      this.rejectTurns(new Error('Bridge reconnect limit reached'))
      return
    }
    const delay = Math.min(500 * 2 ** this.reconnectAttempts++, 10000)
    this.setState('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      void this.open(true).catch(() => {})
    }, delay)
  }
}
