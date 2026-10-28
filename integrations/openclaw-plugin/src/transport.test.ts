import type { ServerMessage } from '@proj-airi/openclaw-bridge/contracts'
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/channel-core'

import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeServerMessage, encodeClientMessage } from '@proj-airi/openclaw-bridge/contracts'
import { expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { createChannel } from './channel'
import { register } from './index'

vi.mock('./channel', () => ({ createChannel: vi.fn() }))

it('receives same-socket cancellation while native approval dispatch is still pending', async () => {
  let route: Parameters<OpenClawPluginApi['registerHttpRoute']>[0] | undefined
  let dispose: (() => void) | undefined
  let releaseApproval: (() => void) | undefined
  const approvalSettled = new Promise<{ text: string, cancelled: boolean }>((resolve) => {
    releaseApproval = () => resolve({ text: '', cancelled: false })
  })
  const approvalDispatch = vi.fn()
  vi.mocked(createChannel).mockImplementation((_api, _config, registry) => ({
    channel: {
      id: 'airi',
      meta: { id: 'airi', label: 'AIRI', selectionLabel: 'AIRI', docsPath: '/channels/airi', blurb: 'Fixture' },
      capabilities: { chatTypes: ['direct'] },
      config: { listAccountIds: () => ['default'], resolveAccount: () => ({ accountId: 'default', enabled: true }) },
    },
    isRunning: () => true,
    sessionKey: (_conversation, peer) => `agent:mitsuki:airi:${peer}`,
    dispatch: async (conversation, message, controller) => {
      if (message.text.startsWith('/approve')) {
        approvalDispatch()
        return approvalSettled
      }
      registry.recordApproval(conversation, 'owned-approval', {
        version: 1,
        type: 'approval.request',
        approvalId: 'owned-approval',
        kind: 'exec',
        description: 'Harmless fixture approval',
        allowedDecisions: ['deny'],
      })
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { text: '', cancelled: true }
    },
  }))
  const credential = 'socket-fixture-token-'.repeat(3)
  register(Object.assign({} as OpenClawPluginApi, {
    config: { agents: { entries: { mitsuki: {} } } },
    pluginConfig: { clients: [{ principalId: 'fixture-person', agentIds: ['mitsuki'], token: credential }] },
    runtime: { version: '2026.10.3', state: { resolveStateDir: () => mkdtempSync(join(tmpdir(), 'airi-socket-fixture-')) } },
    logger: { warn: vi.fn(), error: vi.fn() },
    lifecycle: { onDispose: (callback: () => void) => { dispose = callback } },
    registerChannel: vi.fn(),
    registerTool: vi.fn(),
    registerHttpRoute: (value: Parameters<OpenClawPluginApi['registerHttpRoute']>[0]) => { route = value },
  }))
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    void route?.handleUpgrade?.(request, socket, head)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture listener')
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/plugins/airi/v1`)
  const received: ServerMessage[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Cancellation blocked behind approval dispatch')), 2000)
      socket.on('open', () => socket.send(encodeClientMessage({ version: 1, type: 'hello', token: credential, clientId: 'test', conversationId: 'test', agentId: 'mitsuki' })))
      socket.on('message', (data) => {
        const message = decodeServerMessage(String(data))
        received.push(message)
        if (message.type === 'ready')
          socket.send(encodeClientMessage({ version: 1, type: 'user.message', messageId: 'owned-turn', text: 'Run harmless command', input: 'text' }))
        if (message.type === 'approval.request') {
          socket.send(encodeClientMessage({ version: 1, type: 'approval.resolve', approvalId: message.approvalId, decision: 'deny' }))
          socket.send(encodeClientMessage({ version: 1, type: 'turn.cancel', messageId: 'owned-turn' }))
        }
        if (message.type === 'response.cancelled') {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
    expect(approvalDispatch).toHaveBeenCalledOnce()
    expect(received.filter(message => message.type === 'response.cancelled')).toHaveLength(1)
    expect(received.some(message => message.type === 'response.final')).toBe(false)
  }
  finally {
    releaseApproval?.()
    dispose?.()
    socket.terminate()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
