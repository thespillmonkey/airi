import type { ClientMessage, ServerMessage } from '@proj-airi/openclaw-bridge/contracts'
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/channel-core'

import type { Connection, Conversation, TurnTerminal } from './registry'

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { decodeClientMessage, encodeServerMessage, presentationCommandSchema } from '@proj-airi/openclaw-bridge/contracts'
import { toJsonSchema } from '@valibot/to-json-schema'
import { listAgentIds } from 'openclaw/plugin-sdk/agent-scope-runtime'
import { WebSocket, WebSocketServer } from 'ws'

import * as v from 'valibot'

import { createChannel } from './channel'
import { authenticate, readConfig } from './config'
import { createRegistry } from './registry'

/**
 * Load one native channel and its authenticated presentation endpoint.
 *
 * Call stack:
 * OpenClaw plugin loader
 *   -> register
 *     -> createChannel -> core ingress and reply dispatch
 *     -> WebSocket endpoint -> client registry -> presentation tools
 */
export function register(api: OpenClawPluginApi) {
  if (api.runtime.version !== '2026.10.3')
    throw new Error('AIRI requires the tested OpenClaw version 2026.10.3')
  if (!api.lifecycle.onDispose)
    throw new Error('AIRI requires the OpenClaw plugin disposal lifecycle')
  const config = readConfig(api.pluginConfig)
  const registry = createRegistry(join(api.runtime.state.resolveStateDir(), 'plugins', 'airi'))
  const native = createChannel(api, config, registry)
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1048576, perMessageDeflate: false })
  let stopped = false
  const approvalRuns = new Set<AbortController>()

  const toolArgsSchema = v.strictObject({ command: presentationCommandSchema })
  api.registerChannel({ plugin: native.channel })
  api.registerTool((context) => {
    if (context.messageChannel !== 'airi' || !context.sessionKey || !context.requesterSenderId)
      return null
    const sessionKey = context.sessionKey
    const senderId = context.requesterSenderId
    return {
      name: 'airi_presentation',
      label: 'AIRI presentation',
      description: 'Discover and control this conversation’s avatar, voice, settings, and saved profiles. Read available options before a change.',
      parameters: toJsonSchema(toolArgsSchema),
      execute: async (_toolCallId, params, signal) => {
        context.assertInvocationCurrent?.()
        const { command } = v.parse(toolArgsSchema, params)
        const conversation = registry.forSession(sessionKey, senderId)
        const result = await registry.request(conversation, command, signal)
        context.assertInvocationCurrent?.()
        if (!result.state)
          throw new Error('AIRI did not acknowledge its effective presentation state')
        const details = { state: result.state, capabilities: result.capabilities, profiles: result.profiles }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      },
    }
  }, { name: 'airi_presentation', optional: true })

  async function run(conversation: Conversation, message: Extract<ClientMessage, { type: 'user.message' }>) {
    const controller = registry.beginTurn(conversation, message.messageId)
    if (!controller)
      return
    registry.emit(conversation, { version: 1, type: 'response.accepted', messageId: message.messageId, sessionKey: conversation.sessionKey })
    registry.emit(conversation, { version: 1, type: 'status', state: 'thinking' })
    let terminal: TurnTerminal
    try {
      const result = await native.dispatch(conversation, message, controller)
      terminal = result.cancelled
        ? { version: 1, type: 'response.cancelled', messageId: message.messageId }
        : { version: 1, type: 'response.final', messageId: message.messageId, text: result.text }
    }
    catch {
      api.logger.error('AIRI channel agent dispatch failed. Inspect core dispatch diagnostics.')
      // Raw provider exceptions can contain credentials. Only a bounded component error crosses the transport.
      terminal = controller.signal.aborted
        ? { version: 1, type: 'response.cancelled', messageId: message.messageId }
        : { version: 1, type: 'response.error', messageId: message.messageId, code: 'agent_dispatch_failed', message: 'The OpenClaw agent turn failed. Inspect Gateway diagnostics.' }
    }
    registry.completeTurn(conversation, terminal)
  }

  sockets.on('connection', (socket) => {
    let conversation: Conversation | undefined
    let authenticated = false
    const handshakeTimer = setTimeout(() => socket.close(4001, 'Authentication timed out'), 5000)
    const connection: Connection = {
      send: (message: ServerMessage) => {
        if (socket.readyState !== WebSocket.OPEN)
          throw new Error('AIRI socket is closed')
        if (socket.bufferedAmount > 1048576) {
          socket.close(4429, 'Outbound queue exceeded')
          throw new Error('AIRI outbound queue exceeded')
        }
        socket.send(encodeServerMessage(message))
      },
      close: () => socket.close(4409, 'Connection replaced'),
    }
    let queuedFrames = 0
    let receiveQueue = Promise.resolve()
    socket.on('message', (data, binary) => {
      if (binary || queuedFrames >= 32) {
        socket.close(4008, 'Invalid frame or inbound queue exceeded')
        return
      }
      queuedFrames++
      receiveQueue = receiveQueue.then(async () => {
        if (stopped || socket.readyState !== WebSocket.OPEN)
          return
        const message = decodeClientMessage(data.toString())
        if (!authenticated) {
          if (message.type !== 'hello')
            throw new Error('The first frame must authenticate')
          if (!native.isRunning())
            throw new Error('The AIRI channel listener is not ready')
          if (!native.channel.config.resolveAccount(api.config).enabled)
            throw new Error('The AIRI channel is disabled')
          const principal = authenticate(config, message.token)
          const agentIds = new Set(listAgentIds(api.config))
          if (!agentIds.has(message.agentId))
            throw new Error('The selected agent does not exist')
          conversation = registry.attach(principal, message, connection, peerId => native.sessionKey(message, peerId))
          authenticated = true
          clearTimeout(handshakeTimer)
          connection.send({
            version: 1,
            type: 'ready',
            connectionId: conversation.connectionId!,
            sessionKey: conversation.sessionKey,
            agentId: conversation.agentId,
            agents: principal.agentIds.filter(id => agentIds.has(id)).map(id => ({ id, name: id })),
            capabilities: conversation.capabilities,
          })
          registry.replay(conversation, message.lastSequence ?? 0)
          return
        }
        if (!conversation || conversation.connection !== connection)
          throw new Error('This connection no longer owns the conversation')
        switch (message.type) {
          case 'hello':
            throw new Error('This connection already authenticated')
          case 'user.message':
            void run(conversation, message).catch(() => {
              registry.emit(conversation!, { version: 1, type: 'response.error', messageId: message.messageId, code: 'turn_rejected', message: 'Cancel the active response or start a new conversation.' })
            })
            break
          case 'turn.cancel':
            registry.cancel(conversation, message.messageId)
            break
          case 'capabilities.update':
            registry.update(conversation, message.capabilities, message.state)
            break
          case 'presentation.result':
            registry.acceptResult(conversation, message)
            break
          case 'approval.resolve': {
            if (approvalRuns.size >= 32)
              throw new Error('Too many active approval commands')
            const command = registry.resolveApproval(conversation, message.approvalId, message.decision)
            const approvalConversation = conversation
            const controller = new AbortController()
            approvalRuns.add(controller)
            // Core receives the same authenticated sender and enforces its normal reviewer policy.
            // Approval dispatch can await the resumed agent. Keep cancellation and acknowledgements responsive.
            void native.dispatch(approvalConversation, {
              version: 1,
              type: 'user.message',
              messageId: randomUUID(),
              input: 'text',
              text: command,
            }, controller).catch(() => {
              if (!stopped)
                registry.emit(approvalConversation, { version: 1, type: 'response.error', code: 'approval_dispatch_failed', message: 'The native approval command failed. Check its current status before retrying.' })
            }).finally(() => { approvalRuns.delete(controller) })
            break
          }
        }
      }).catch(() => {
        api.logger.warn('AIRI bridge rejected an authentication, authorization, or protocol frame.')
        // Authentication and schema failures never echo source frames or credentials.
        socket.close(4003, 'AIRI frame rejected. Check configuration and connection state.')
      }).finally(() => { queuedFrames-- })
    })
    socket.on('close', () => {
      clearTimeout(handshakeTimer)
      if (conversation)
        registry.disconnect(conversation, connection)
    })
    socket.on('error', () => {
      if (conversation)
        registry.disconnect(conversation, connection)
    })
  })

  api.registerHttpRoute({
    path: '/plugins/airi/v1',
    auth: 'plugin',
    handler: (_request, response) => {
      response.writeHead(426, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'WebSocket upgrade required' }))
      return true
    },
    handleUpgrade: (request, socket, head) => {
      if (stopped)
        return false
      const origin = request.headers.origin
      if (origin && !config.allowedOrigins.includes(origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return true
      }
      if (sockets.clients.size >= 32) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n')
        return true
      }
      sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
      return true
    },
  })
  api.lifecycle.onDispose(() => {
    stopped = true
    for (const controller of approvalRuns)
      controller.abort()
    approvalRuns.clear()
    registry.dispose()
    for (const socket of sockets.clients)
      socket.terminate()
    sockets.close()
  })
}

export default { id: 'airi', name: 'AIRI Agent Mode', description: 'AIRI channel and presentation tools', register }
