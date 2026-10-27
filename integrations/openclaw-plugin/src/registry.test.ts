import type { ClientMessage, PresentationCapabilities, PresentationState, ServerMessage } from '@proj-airi/openclaw-bridge/contracts'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRegistry } from './registry'

const principal = { principalId: 'person-a', tokenEnv: 'AIRI_TEST_TOKEN', agentIds: ['mitsuki'] }
const hello: Extract<ClientMessage, { type: 'hello' }> = {
  version: 1,
  type: 'hello',
  token: 'unused-auth-boundary-fixture',
  clientId: 'desktop-a',
  conversationId: 'conversation-a',
  agentId: 'mitsuki',
}
const capabilities: PresentationCapabilities = {
  avatars: [{ id: 'avatar-a', name: 'Avatar A', format: 'vrm', available: true, controls: [] }],
  voices: [{ id: 'voice-a', name: 'Voice A', providerId: 'tts-a', modelId: 'model-a', parameters: [{ key: 'rate', min: 0.5, max: 2 }] }],
  ttsProviders: [{ id: 'tts-a', name: 'TTS A', models: [{ id: 'model-a', name: 'Model A' }], voiceDiscovery: 'configured' }],
  settings: [{ key: 'speechVolume', type: 'number', supported: true, min: 0, max: 1 }],
  profileScopes: ['client', 'conversation'],
  activeAvatarControls: [],
}
const state: PresentationState = { revision: 1, avatarId: 'avatar-a', settings: { speechVolume: 0.5 }, scope: 'conversation' }

afterEach(() => vi.useRealTimers())

describe('conversation registry', () => {
  it('isolates clients and principals, preserves session identity on reconnect, and deduplicates messages', () => {
    const registry = createRegistry()
    const first = { send: vi.fn(), close: vi.fn() }
    const conversation = registry.attach(principal, hello, first, peer => `session:${peer}`)
    const controller = registry.beginTurn(conversation, 'message-a')
    expect(controller).toBeInstanceOf(AbortController)
    expect(registry.beginTurn(conversation, 'message-a')).toBeUndefined()
    expect(() => registry.beginTurn(conversation, 'message-b')).toThrow('response is active')
    registry.disconnect(conversation, first)
    const second = { send: vi.fn(), close: vi.fn() }
    const reconnected = registry.attach(principal, hello, second, peer => `session:${peer}`)
    expect(reconnected.sessionKey).toBe(conversation.sessionKey)
    expect(registry.beginTurn(reconnected, 'message-a')).toBeUndefined()
    const other = registry.attach(principal, { ...hello, clientId: 'desktop-b' }, { send: vi.fn(), close: vi.fn() }, peer => `session:${peer}`)
    expect(other.sessionKey).not.toBe(conversation.sessionKey)
    expect(() => registry.forSession(conversation.sessionKey, 'person-b')).toThrow('No connected AIRI client')
    expect(() => registry.attach(principal, { ...hello, agentId: 'other-agent' }, second, peer => peer)).toThrow('not allowed')
    registry.dispose()
  })

  it('cancels only the selected message and does not cancel another client', () => {
    const registry = createRegistry()
    const first = registry.attach(principal, hello, { send: vi.fn(), close: vi.fn() }, peer => peer)
    const second = registry.attach(principal, { ...hello, clientId: 'desktop-b' }, { send: vi.fn(), close: vi.fn() }, peer => peer)
    const firstRun = registry.beginTurn(first, 'message-a')!
    const secondRun = registry.beginTurn(second, 'message-a')!
    expect(registry.cancel(first, 'message-a')).toBe(true)
    expect(firstRun.signal.aborted).toBe(true)
    expect(secondRun.signal.aborted).toBe(false)
    registry.finishTurn(first, 'message-a')
    expect(registry.cancel(first, 'message-a')).toBe(false)
    registry.dispose()
  })

  it('replays only unseen ordered events and refuses gaps', () => {
    const registry = createRegistry()
    const connection = { send: vi.fn(), close: vi.fn() }
    const conversation = registry.attach(principal, hello, connection, peer => peer)
    registry.emit(conversation, { version: 1, type: 'response.delta', messageId: 'message-a', text: 'Hello' })
    registry.emit(conversation, { version: 1, type: 'response.final', messageId: 'message-a', text: 'Hello there' })
    connection.send.mockClear()
    registry.replay(conversation, 1)
    expect(connection.send).toHaveBeenCalledTimes(1)
    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.final', sequence: 2 }))
    for (let index = 0; index < 256; index++)
      registry.emit(conversation, { version: 1, type: 'status', state: 'idle' })
    expect(() => registry.attach(principal, hello, connection, peer => peer)).toThrow('Replay window expired')
    registry.dispose()
  })

  it('requires a correlated effective-state acknowledgement and rejects unsupported selections before send', async () => {
    const registry = createRegistry()
    const sent: ServerMessage[] = []
    const connection = { send: (message: ServerMessage) => {
      sent.push(message)
    }, close: vi.fn() }
    const conversation = registry.attach(principal, hello, connection, peer => peer)
    registry.update(conversation, capabilities, state)
    await expect(registry.request(conversation, { operation: 'avatar.select', avatarId: 'missing' })).rejects.toThrow('unavailable')
    await expect(registry.request(conversation, { operation: 'voice.select', voice: { providerId: 'tts-a', modelId: 'model-a', voiceId: 'voice-a', parameters: { pitch: 1 } } })).rejects.toThrow('unsupported')
    expect(sent).toHaveLength(0)
    const pending = registry.request(conversation, { operation: 'settings.update', settings: { speechVolume: 0.8 } })
    const request = sent[0]
    expect(request.type).toBe('presentation.request')
    if (request.type !== 'presentation.request')
      throw new Error('Expected presentation request')
    expect(registry.acceptResult(conversation, { version: 1, type: 'presentation.result', actionId: 'wrong-id', ok: true, state })).toBe(false)
    const effective = { ...state, revision: 2, settings: { speechVolume: 0.8 } }
    registry.acceptResult(conversation, { version: 1, type: 'presentation.result', actionId: request.actionId, ok: true, state: effective, capabilities })
    await expect(pending).resolves.toEqual(expect.objectContaining({ state: effective }))
    expect(conversation.state?.settings.speechVolume).toBe(0.8)
    registry.dispose()
  })

  it('rejects in-flight commands on disconnect and requires fresh capabilities', async () => {
    const registry = createRegistry()
    const connection = { send: vi.fn(), close: vi.fn() }
    const conversation = registry.attach(principal, hello, connection, peer => peer)
    registry.update(conversation, capabilities, state)
    const result = registry.request(conversation, { operation: 'state.read' })
    const rejection = expect(result).rejects.toThrow('disconnected')
    registry.disconnect(conversation, connection)
    await rejection
    expect(conversation.state).toBeUndefined()
    expect(conversation.actions.size).toBe(0)
    registry.dispose()
  })

  it('invalidates uncertain state on timeout and permits explicit state recovery', async () => {
    vi.useFakeTimers()
    const registry = createRegistry()
    const connection = { send: vi.fn(), close: vi.fn() }
    const conversation = registry.attach(principal, hello, connection, peer => peer)
    registry.update(conversation, capabilities, state)
    const result = registry.request(conversation, { operation: 'avatar.select', avatarId: 'avatar-a' })
    const rejection = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15000)
    await rejection
    await expect(registry.request(conversation, { operation: 'avatars.list' })).rejects.toThrow('Read state')
    const recovery = registry.request(conversation, { operation: 'state.read' })
    const request = connection.send.mock.calls.at(-1)?.[0] as ServerMessage
    if (request.type !== 'presentation.request')
      throw new Error('Expected presentation request')
    registry.acceptResult(conversation, { version: 1, type: 'presentation.result', actionId: request.actionId, ok: true, state, capabilities })
    await expect(recovery).resolves.toEqual(expect.objectContaining({ state }))
    registry.dispose()
  })

  it('persists admission before dispatch and never reruns an interrupted turn after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'airi-plugin-test-'))
    try {
      const first = createRegistry(directory)
      const conversation = first.attach(principal, hello, { send: vi.fn(), close: vi.fn() }, peer => peer)
      first.beginTurn(conversation, 'message-a')
      first.emit(conversation, { version: 1, type: 'response.delta', messageId: 'message-a', text: 'Partial' })
      first.dispose()
      const second = createRegistry(directory)
      const connection = { send: vi.fn(), close: vi.fn() }
      const restored = second.attach(principal, hello, connection, peer => peer)
      expect(second.beginTurn(restored, 'message-a')).toBeUndefined()
      second.replay(restored, 0)
      expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'host_restarted', messageId: 'message-a', sequence: 2 }))
      expect(restored.sequence).toBe(2)
      second.dispose()
    }
    finally {
      rmSync(directory, { recursive: true })
    }
  })

  it('replays only source-recorded approvals and enforces the allowed decisions', () => {
    const registry = createRegistry()
    const connection = { send: vi.fn(), close: vi.fn() }
    const conversation = registry.attach(principal, hello, connection, peer => peer)
    registry.recordApproval(conversation, 'request-slug', {
      version: 1,
      type: 'approval.request',
      approvalId: 'approval-a',
      kind: 'exec',
      description: 'An approved command',
      allowedDecisions: ['allow-once', 'deny'],
    })
    connection.send.mockClear()
    registry.replay(conversation, 0)
    expect(connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request', approvalId: 'approval-a' }))
    expect(() => registry.resolveApproval(conversation, 'approval-a', 'allow-always')).toThrow('unavailable')
    expect(() => registry.resolveApproval(conversation, 'unrelated-id', 'allow-once')).toThrow('unavailable')
    expect(registry.resolveApproval(conversation, 'approval-a', 'allow-once')).toBe('/approve request-slug allow-once')
    expect(() => registry.resolveApproval(conversation, 'approval-a', 'allow-once')).toThrow('unavailable')
    registry.dispose()
  })

  it('releases admission atomically before terminal publication so an immediate follow-up is accepted', () => {
    const registry = createRegistry()
    let followup: AbortController | undefined
    let conversation: ReturnType<typeof registry.attach>
    const connection = { send: vi.fn((message: ServerMessage) => {
      if (message.type === 'response.final')
        followup = registry.beginTurn(conversation, 'next-message')
    }), close: vi.fn() }
    conversation = registry.attach(principal, hello, connection, peer => peer)
    registry.beginTurn(conversation, 'first-message')
    expect(registry.completeTurn(conversation, { version: 1, type: 'response.final', messageId: 'first-message', text: 'Done' })).toBe(true)
    expect(followup).toBeInstanceOf(AbortController)
    expect(registry.completeTurn(conversation, { version: 1, type: 'response.final', messageId: 'first-message', text: 'Duplicate' })).toBe(false)
    expect(connection.send.mock.calls.filter(([message]) => message.type === 'response.final')).toHaveLength(1)
    registry.dispose()
  })
})
