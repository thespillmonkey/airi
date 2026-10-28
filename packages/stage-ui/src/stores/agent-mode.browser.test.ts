import type { BridgeClientCallbacks } from '@proj-airi/openclaw-bridge'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { useAgentModeStore } from './agent-mode'

const transport = vi.hoisted(() => ({ callbacks: undefined as BridgeClientCallbacks | undefined, sends: vi.fn() }))
vi.mock('@proj-airi/openclaw-bridge', async (original) => {
  const contracts = await original<typeof import('@proj-airi/openclaw-bridge')>()
  return {
    ...contracts,
    OpenClawBridgeClient: class {
      constructor(callbacks: BridgeClientCallbacks) { transport.callbacks = callbacks }
      async connect() {
        transport.callbacks?.onStateChange?.('ready')
        return { version: 1, type: 'ready', connectionId: 'connection', sessionKey: 'isolated-session', agentId: 'mitsuki', agents: [] }
      }

      disconnect() { transport.callbacks?.onStateChange?.('disconnected') }
      updateCapabilities() {}
      resolveApproval() {}
      send(text: string, options: unknown) {
        transport.sends(text, options)
        return { accepted: Promise.resolve({ messageId: 'message', sessionKey: 'isolated-session' }), done: Promise.resolve('reply') }
      }
    },
  }
})

function host() {
  return { begin: vi.fn(async () => {}), restore: vi.fn(async () => {}), execute: vi.fn(async () => ({ ok: true })) }
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  transport.sends.mockClear()
  transport.callbacks = undefined
})

describe('agent Mode ownership', () => {
  it('retains Agent Mode after a bridge error without resuming normal generation', async () => {
    const mode = useAgentModeStore()
    const presentation = host()
    mode.attachChat({ event: vi.fn(async () => {}), stop: vi.fn(async () => {}) })
    await mode.attachPresentation(presentation)
    presentation.restore.mockClear()
    await mode.selectMode('agent')
    await mode.connect({ url: 'ws://localhost/plugins/airi/v1', token: 'private', agentId: 'mitsuki', conversationId: 'conversation' })
    transport.callbacks?.onStateChange?.('error', 'Connection lost')
    expect(mode.active).toBe(true)
    expect(mode.ready).toBe(false)
    expect(() => mode.send('hello', { messageId: 'message', conversationId: 'conversation', input: 'text' })).toThrow('disconnected')
    expect(presentation.restore).not.toHaveBeenCalled()
    expect(JSON.stringify(localStorage)).not.toContain('private')
  })

  it('rejects conversation changes while preserving the original binding', async () => {
    const mode = useAgentModeStore()
    mode.attachChat({ event: vi.fn(async () => {}), stop: vi.fn(async () => {}) })
    await mode.attachPresentation(host())
    await mode.selectMode('agent')
    await mode.connect({ url: 'ws://localhost/plugins/airi/v1', token: 'private', agentId: 'mitsuki', conversationId: 'conversation' })
    expect(() => mode.send('other', { messageId: 'other', conversationId: 'unbound', input: 'voice' })).toThrow('Connect this conversation')
    mode.send('hello', { messageId: 'message', conversationId: 'conversation', input: 'voice' })
    expect(transport.sends).toHaveBeenCalledTimes(1)
    expect(transport.sends).toHaveBeenCalledWith('hello', { messageId: 'message', conversationId: 'conversation', input: 'voice' })
  })

  it('restores normal presentation before allowing Normal Mode', async () => {
    const mode = useAgentModeStore()
    const presentation = host()
    const restore = Promise.withResolvers<void>()
    mode.attachChat({ event: vi.fn(async () => {}), stop: vi.fn(async () => {}) })
    await mode.attachPresentation(presentation)
    presentation.restore.mockClear()
    await mode.selectMode('agent')
    presentation.restore.mockImplementation(() => restore.promise)
    const switching = mode.selectMode('normal')
    await Promise.resolve()
    expect(mode.active).toBe(true)
    restore.resolve()
    await switching
    expect(mode.active).toBe(false)
    expect(presentation.restore).toHaveBeenCalledOnce()
  })

  it('drops queued events after an explicit mode transition', async () => {
    const mode = useAgentModeStore()
    const event = vi.fn(async () => {})
    mode.attachChat({ event, stop: vi.fn(async () => {}) })
    await mode.attachPresentation(host())
    await mode.selectMode('agent')
    await mode.connect({ url: 'ws://localhost/plugins/airi/v1', token: 'private', agentId: 'mitsuki', conversationId: 'conversation' })
    transport.callbacks?.onEvent?.({ version: 1, type: 'response.delta', messageId: 'old', text: 'stale', sequence: 1 })
    await mode.selectMode('normal')
    await Promise.resolve()
    expect(event).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'response.delta' }))
  })

  it('keeps Agent Mode selected if presentation restoration fails', async () => {
    const mode = useAgentModeStore()
    const presentation = host()
    mode.attachChat({ event: vi.fn(async () => {}), stop: vi.fn(async () => {}) })
    await mode.attachPresentation(presentation)
    await mode.selectMode('agent')
    presentation.restore.mockRejectedValue(new Error('Avatar restore failed'))
    await expect(mode.selectMode('normal')).rejects.toThrow('Avatar restore failed')
    expect(mode.active).toBe(true)
    expect(mode.ready).toBe(false)
    expect(localStorage.getItem('openclaw/mode')).toBe('agent')
  })

  it('routes follower mode changes to one speech owner without replaying snapshot effects', async () => {
    const namespace = `agent-mode:${crypto.randomUUID()}`
    const leader = createSyncedPiniaPlugin({ namespace, leadership: 'leader-only', callTimeout: 3000 })
    const follower = createSyncedPiniaPlugin({ namespace, leadership: 'follower-only', callTimeout: 3000 })
    const leaderPinia = createPinia().use(leader.plugin)
    const followerPinia = createPinia().use(follower.plugin)
    createApp({}).use(leaderPinia)
    createApp({}).use(followerPinia)
    const releaseRole = leader.addRole('speech-player')
    try {
      await vi.waitFor(() => expect(leader.isLeader()).toBe(true))
      const leaderStore = useAgentModeStore(leaderPinia)
      const followerStore = useAgentModeStore(followerPinia)
      const leaderPresentation = host()
      const followerPresentation = host()
      leaderStore.attachChat({ event: vi.fn(async () => {}), stop: vi.fn(async () => {}) })
      await leaderStore.attachPresentation(leaderPresentation)
      await followerStore.attachPresentation(followerPresentation)
      await vi.waitFor(() => expect(follower.getLeaderId()).toBe(leader.participantId))
      await followerStore.selectMode('agent')
      await vi.waitFor(() => expect(followerStore.active).toBe(true))
      expect(leaderPresentation.begin).toHaveBeenCalledOnce()
      expect(followerPresentation.begin).not.toHaveBeenCalled()
      await followerStore.selectMode('agent')
      expect(leaderPresentation.begin).toHaveBeenCalledOnce()
    }
    finally {
      releaseRole()
      leader.dispose()
      follower.dispose()
      disposePinia(leaderPinia)
      disposePinia(followerPinia)
    }
  })

  it('waits for ordered asynchronous response projection before send completion', async () => {
    const mode = useAgentModeStore()
    const release = Promise.withResolvers<void>()
    const projected: string[] = []
    mode.attachChat({
      async event(event) {
        if (event.type === 'response.delta') {
          await release.promise
          projected.push(event.text)
        }
        if (event.type === 'response.final')
          projected.push(event.text)
      },
      stop: vi.fn(async () => {}),
    })
    await mode.attachPresentation(host())
    await mode.selectMode('agent')
    await mode.connect({ url: 'ws://localhost/plugins/airi/v1', token: 'private', agentId: 'mitsuki', conversationId: 'conversation' })
    const request = mode.send('hello', { messageId: 'message', conversationId: 'conversation', input: 'text' })
    transport.callbacks?.onEvent?.({ version: 1, type: 'response.delta', messageId: 'message', text: 'first', sequence: 1 })
    transport.callbacks?.onEvent?.({ version: 1, type: 'response.final', messageId: 'message', text: 'complete', sequence: 2 })
    let finished = false
    void request.done.then(() => {
      finished = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(finished).toBe(false)
    release.resolve()
    await request.done
    expect(projected).toEqual(['first', 'complete'])
    expect(finished).toBe(true)
  })

  it('invalidates captured voice input after leaving and re-entering Agent Mode', async () => {
    const mode = useAgentModeStore()
    await mode.selectMode('agent')
    const current = mode.captureInputContext()
    expect(current()).toBe(true)
    await mode.selectMode('normal')
    await mode.selectMode('agent')
    expect(current()).toBe(false)
  })

  it('keeps a submitted approval pending until the native acknowledgment or expiry', async () => {
    const mode = useAgentModeStore()
    mode.attachChat({ event: vi.fn(async () => {}), stop: vi.fn(async () => {}) })
    await mode.attachPresentation(host())
    await mode.selectMode('agent')
    await mode.connect({ url: 'ws://localhost/plugins/airi/v1', token: 'private', agentId: 'mitsuki', conversationId: 'conversation' })
    await transport.callbacks?.onEvent?.({ version: 1, type: 'approval.request', kind: 'exec', approvalId: 'approval', description: 'Approve command', allowedDecisions: ['allow-once', 'deny'] })
    await expect(mode.resolveApproval('approval', 'allow-always')).rejects.toThrow('not available')
    await mode.resolveApproval('approval', 'allow-once')
    expect(mode.approvals[0]?.resolving).toBe(true)
    await transport.callbacks?.onEvent?.({ version: 1, type: 'approval.resolved', approvalId: 'approval', status: 'resolved', decision: 'allow-once', applicationStatus: 'applied', sequence: 1 })
    expect(mode.approvals).toEqual([])
    expect(mode.approvalFeedback).toBe('resolved')
    await transport.callbacks?.onEvent?.({ version: 1, type: 'approval.request', kind: 'exec', approvalId: 'external', description: 'External approval', allowedDecisions: ['deny'] })
    await transport.callbacks?.onEvent?.({ version: 1, type: 'approval.resolved', approvalId: 'external', status: 'expired', sequence: 2 })
    expect(mode.approvals).toEqual([])
    expect(mode.approvalFeedback).toBe('expired')
  })

  it('validates a credential-free configured voice catalog before persisting it', async () => {
    const mode = useAgentModeStore()
    const voice = { providerId: 'configured', modelId: 'tts', voiceId: 'custom' }
    await mode.setVoiceCatalog(JSON.stringify([voice]))
    expect(mode.configuredVoices).toEqual([voice])
    await expect(mode.setVoiceCatalog(JSON.stringify([{ ...voice, apiKey: 'private' }]))).rejects.toThrow()
    expect(mode.configuredVoices).toEqual([voice])
    expect(localStorage.getItem('openclaw/voice-catalog')).not.toContain('private')
  })
})
