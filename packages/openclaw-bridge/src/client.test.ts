import type { AddressInfo } from 'node:net'

import type { WebSocket as ServerSocket } from 'ws'

import type { ClientMessage, ServerMessage } from './contracts'

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import { OpenClawBridgeClient } from './client'
import { decodeClientMessage, encodeServerMessage } from './contracts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

/** Uses a real loopback server and the runtime's native WebSocket client. */
async function server(handle: (message: ClientMessage, socket: ServerSocket, connection: number) => void) {
  const host = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => host.once('listening', resolve))
  let connections = 0
  const received: ClientMessage[] = []
  host.on('connection', (socket) => {
    const connection = ++connections
    socket.on('message', (data) => {
      const message = decodeClientMessage(data.toString())
      received.push(message)
      if (message.type === 'hello')
        emit(socket, { version: 1, type: 'ready', connectionId: `connection-${connection}`, sessionKey: 'agent:test:airi:conversation', agentId: 'test', agents: [{ id: 'test', name: 'Test agent' }] })
      handle(message, socket, connection)
    })
  })
  cleanups.push(async () => {
    for (const socket of host.clients)
      socket.terminate()
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()))
  })
  return { url: `ws://127.0.0.1:${(host.address() as AddressInfo).port}/plugins/airi/v1`, received }
}

function emit(socket: ServerSocket, event: ServerMessage) {
  socket.send(encodeServerMessage(event))
}
function options(url: string) {
  return { url, token: 'test-only-client-credential', clientId: 'client-a', conversationId: 'conversation', agentId: 'test' }
}
function own(client: OpenClawBridgeClient) {
  cleanups.push(async () => client.disconnect())
  return client
}

describe('openClawBridgeClient over real WebSocket transport', () => {
  it('streams user-facing text once and preserves admission and final response identity', async () => {
    const events: ServerMessage[] = []
    const host = await server((message, socket) => {
      if (message.type !== 'user.message')
        return
      emit(socket, { version: 1, type: 'response.accepted', messageId: message.messageId, sessionKey: 'agent:test:airi:conversation', sequence: 1 })
      const delta = { version: 1 as const, type: 'response.delta' as const, messageId: message.messageId, text: 'Hello', sequence: 2 }
      emit(socket, delta)
      emit(socket, delta)
      emit(socket, { version: 1, type: 'response.final', messageId: message.messageId, text: 'Hello Gary', sequence: 3 })
    })
    const client = own(new OpenClawBridgeClient({ onEvent: (event) => {
      events.push(event)
    } }))
    await client.connect(options(host.url))
    const turn = client.send('Hello', { messageId: 'turn-1', conversationId: 'conversation', input: 'voice' })
    expect(await turn.accepted).toEqual({ messageId: 'turn-1', sessionKey: 'agent:test:airi:conversation' })
    expect(await turn.done).toBe('Hello Gary')
    expect(events.filter(event => event.type === 'response.delta')).toHaveLength(1)
    expect(host.received.find(message => message.type === 'user.message')).toMatchObject({ messageId: 'turn-1', input: 'voice' })
  })

  it('waits for asynchronous transcript projection before completing a turn', async () => {
    const projection = Promise.withResolvers<void>()
    let projected = false
    const host = await server((message, socket) => {
      if (message.type === 'user.message') {
        emit(socket, { version: 1, type: 'response.accepted', messageId: message.messageId, sessionKey: 'agent:test:airi:conversation', sequence: 1 })
        emit(socket, { version: 1, type: 'response.final', messageId: message.messageId, text: 'Stored response', sequence: 2 })
      }
    })
    const client = own(new OpenClawBridgeClient({
      onEvent: async (event) => {
        if (event.type === 'response.final') {
          await projection.promise
          projected = true
        }
      },
    }))
    await client.connect(options(host.url))
    const turn = client.send('Hello', { messageId: 'turn-1', input: 'text' })
    await turn.accepted
    expect(projected).toBe(false)
    projection.resolve()
    expect(await turn.done).toBe('Stored response')
    expect(projected).toBe(true)
  })

  it('reconnects to the same conversation without resubmitting input or replaying speech', async () => {
    const events: ServerMessage[] = []
    const host = await server((message, socket, connection) => {
      if (message.type === 'user.message') {
        emit(socket, { version: 1, type: 'response.accepted', messageId: 'turn-1', sessionKey: 'agent:test:airi:conversation', sequence: 1 })
        emit(socket, { version: 1, type: 'response.delta', messageId: 'turn-1', text: 'One', sequence: 2 })
        socket.close(1012, 'Restart transport')
      }
      if (message.type === 'hello' && connection === 2) {
        expect(message.lastSequence).toBe(2)
        emit(socket, { version: 1, type: 'response.delta', messageId: 'turn-1', text: 'One', sequence: 2 })
        emit(socket, { version: 1, type: 'response.final', messageId: 'turn-1', text: 'One answer', sequence: 3 })
      }
    })
    const client = own(new OpenClawBridgeClient({ onEvent: (event) => {
      events.push(event)
    } }))
    await client.connect(options(host.url))
    const turn = client.send('Hello', { messageId: 'turn-1', input: 'text' })
    expect(await turn.done).toBe('One answer')
    expect(host.received.filter(message => message.type === 'user.message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'response.delta')).toHaveLength(1)
    expect(client.state).toBe('ready')
  })

  it('retries the same stable input ID after loss before server admission', async () => {
    let admitted = 0
    const host = await server((message, socket, connection) => {
      if (message.type !== 'user.message')
        return
      if (connection === 1) {
        socket.close(1012, 'Input was not admitted')
        return
      }
      admitted++
      emit(socket, { version: 1, type: 'response.accepted', messageId: message.messageId, sessionKey: 'agent:test:airi:conversation', sequence: 1 })
      emit(socket, { version: 1, type: 'response.final', messageId: message.messageId, text: 'Recovered', sequence: 2 })
    })
    const client = own(new OpenClawBridgeClient())
    await client.connect(options(host.url))
    const turn = client.send('Keep this input', { messageId: 'stable-id', input: 'text' })
    expect(await turn.done).toBe('Recovered')
    expect(admitted).toBe(1)
    expect(host.received.filter(message => message.type === 'user.message').map(message => message.messageId)).toEqual(['stable-id', 'stable-id'])
  })

  it('expires an input that the server never admits instead of hanging forever', async () => {
    const host = await server(() => {})
    const client = own(new OpenClawBridgeClient())
    await client.connect({ ...options(host.url), admissionTimeoutMs: 30 })
    const turn = client.send('Refused input', { messageId: 'unaccepted', input: 'text' })
    await expect(turn.accepted).rejects.toThrow('admission timed out')
    await expect(turn.done).rejects.toThrow('admission timed out')
  })

  it('cancels owned pending turns on explicit disconnect', async () => {
    const host = await server((message, socket) => {
      if (message.type === 'user.message')
        emit(socket, { version: 1, type: 'response.accepted', messageId: message.messageId, sessionKey: 'agent:test:airi:conversation', sequence: 1 })
    })
    const client = own(new OpenClawBridgeClient())
    await client.connect(options(host.url))
    const turn = client.send('Long work', { messageId: 'turn-1', input: 'text' })
    await turn.accepted
    client.disconnect()
    await expect(turn.done).rejects.toThrow('disconnected')
    await expect.poll(() => host.received.filter(message => message.type === 'turn.cancel').length).toBe(1)
    expect(client.state).toBe('disconnected')
  })

  it('performs a replayed presentation action once and returns effective state', async () => {
    let changes = 0
    const host = await server((message, socket) => {
      if (message.type === 'hello') {
        const request = { version: 1 as const, type: 'presentation.request' as const, actionId: 'action-1', command: { operation: 'settings.update' as const, settings: { speechVolume: 0.25 } } }
        emit(socket, request)
        emit(socket, request)
      }
    })
    const client = own(new OpenClawBridgeClient({
      onPresentation: async () => {
        changes++
        return { ok: true, state: { revision: 1, settings: { speechVolume: 0.25 }, scope: 'conversation' } }
      },
    }))
    await client.connect(options(host.url))
    await expect.poll(() => host.received.filter(message => message.type === 'presentation.result').length).toBe(2)
    expect(changes).toBe(1)
    expect(host.received.find(message => message.type === 'presentation.result')).toMatchObject({ ok: true, state: { settings: { speechVolume: 0.25 } } })
  })

  it('never falls back into a ready conversation after an authentication failure', async () => {
    const states: string[] = []
    const host = await server((message, socket) => {
      if (message.type === 'hello')
        socket.close(4003, 'Credential refused')
    })
    const client = own(new OpenClawBridgeClient({ onStateChange: state => states.push(state) }))
    await client.connect(options(host.url))
    await expect.poll(() => client.state).toBe('error')
    expect(() => client.send('Hello', { messageId: 'turn-1', input: 'text' })).toThrow('disconnected')
    expect(states.at(-1)).toBe('error')
  })

  it('rejects plaintext remote and credential-bearing endpoint URLs', async () => {
    const client = own(new OpenClawBridgeClient())
    await expect(client.connect(options('ws://remote.example/plugins/airi/v1'))).rejects.toThrow('require wss')
    await expect(client.connect(options('wss://remote.example/plugins/airi/v1?token=x'))).rejects.toThrow('endpoint URL')
  })

  it('does not route a message into another AIRI conversation', async () => {
    const host = await server(() => {})
    const client = own(new OpenClawBridgeClient())
    await client.connect(options(host.url))
    expect(() => client.send('Wrong route', { messageId: 'turn-1', conversationId: 'other', input: 'text' })).toThrow('different conversation')
    expect(host.received.filter(message => message.type === 'user.message')).toHaveLength(0)
  })
})
