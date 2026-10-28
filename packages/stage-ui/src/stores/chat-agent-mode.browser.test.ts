import type { BridgeClientCallbacks } from '@proj-airi/openclaw-bridge'

import en from '@proj-airi/i18n/locales/en'

import { Playback } from '@proj-airi/pipelines-audio'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'

import { useAgentModeStore } from './agent-mode'
import { useChatStore } from './chat'
import { useChatSessionStore } from './chat/session-store'
import { useModsServerChannelStore } from './mods/api/channel-server'
import { useSpeechOutputControlStore } from './speech-output-control'
import { useVoiceStore } from './voice'

const transport = vi.hoisted(() => ({
  callbacks: undefined as BridgeClientCallbacks | undefined,
  sends: vi.fn(),
  cancels: vi.fn(),
  pending: new Map<string, ReturnType<typeof Promise.withResolvers<string>>>(),
}))
vi.mock('@proj-airi/openclaw-bridge', async (original) => {
  const contracts = await original<typeof import('@proj-airi/openclaw-bridge')>()
  return {
    ...contracts,
    OpenClawBridgeClient: class {
      constructor(callbacks: BridgeClientCallbacks) { transport.callbacks = callbacks }
      async connect() {
        transport.callbacks?.onStateChange?.('ready')
        return { version: 1, type: 'ready', connectionId: 'connection', sessionKey: 'test-session', agentId: 'codelia', agents: [] }
      }

      disconnect() {
        for (const pending of transport.pending.values())
          pending.reject(new Error('Disconnected'))
        transport.pending.clear()
        transport.callbacks?.onStateChange?.('disconnected')
      }

      updateCapabilities() {}
      resolveApproval() {}
      send(text: string, options: { messageId: string }) {
        transport.sends(text, options)
        const done = Promise.withResolvers<string>()
        transport.pending.set(options.messageId, done)
        return { accepted: Promise.resolve({ messageId: options.messageId, sessionKey: 'test-session' }), done: done.promise }
      }

      cancel(messageId: string) {
        transport.cancels(messageId)
        transport.pending.get(messageId)?.reject(new Error('Cancelled'))
        transport.pending.delete(messageId)
      }
    },
  }
})

const cleanups: (() => void | Promise<void>)[] = []

async function setupChat() {
  const pinia = createPinia()
  setActivePinia(pinia)
  let chat!: ReturnType<typeof useChatStore>
  let voice!: ReturnType<typeof useVoiceStore>
  const view = render(defineComponent({ setup() {
    chat = useChatStore()
    voice = useVoiceStore()
    return () => h('div')
  } }), {
    global: { plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages: { en } })] },
  })
  cleanups.push(() => {
    view.unmount()
    useModsServerChannelStore(pinia).dispose()
    chat.dispose()
    disposePinia(pinia)
  })
  const sessions = useChatSessionStore(pinia)
  await sessions.initialize()
  await sessions.createSession(sessions.sessionMetas[sessions.activeSessionId]?.characterId ?? 'default')
  const playback = new Playback({ nowMs: () => 0, play: () => ({ done: Promise.resolve({ throughMs: 0 }), stop: async () => ({ throughMs: 0 }) }) })
  const detachOutput = voice.connectOutput(() => ({ playback, synthesize: async () => null }))
  const detachHook = chat.onBeforeMessageComposed(async (_message, context) => {
    if (context.speaks)
      voice.startResponse(context)
  })
  const mode = useAgentModeStore(pinia)
  await mode.attachPresentation({ begin: async () => {}, restore: async () => {}, execute: async () => ({ ok: true }) })
  await mode.selectMode('agent')
  await mode.connect({ url: 'ws://localhost/plugins/airi/v1', token: 'fixture', agentId: 'codelia', conversationId: sessions.activeSessionId })
  cleanups.push(async () => {
    await mode.disconnect()
    detachHook()
    detachOutput()
  })
  return { chat, sessions, voice, output: useSpeechOutputControlStore(pinia) }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  transport.pending.clear()
  transport.callbacks = undefined
  transport.sends.mockClear()
  transport.cancels.mockClear()
  localStorage.clear()
})

// https://discord.com/channels/1489521417572847676/1489521418206183597/1564836281438052395
// ROOT CAUSE:
// Remote turns opened speech only after their first text delta, so Stop found no response during thinking.
// Opening response ownership before admission gives Stop the remote generation's identity.
it('registers an admitted remote turn with Stop before its first text delta', async () => {
  const { chat, sessions, voice, output } = await setupChat()
  const sessionId = sessions.activeSessionId
  await chat.submit({ sessionId, messageId: 'thinking', text: 'Wait for cancellation.' })
  expect(transport.sends).toHaveBeenCalledOnce()
  expect(voice.activeTurns.map(({ sessionId, turnId }) => ({ sessionId, turnId }))).toEqual([{ sessionId, turnId: 'thinking' }])
  await output.requestStopSpeaking({ reason: 'manual-chat', sessionId })
  await expect.poll(() => transport.cancels.mock.calls).toContainEqual(['thinking'])
  await expect.poll(() => chat.sending).toBe(false)
  await expect.poll(() => voice.activeTurns.length).toBe(0)
})

it('does not admit a remote request cancelled while the speech host is preparing', async () => {
  const { chat, sessions, voice, output } = await setupChat()
  const sessionId = sessions.activeSessionId
  const preparation = Promise.withResolvers<void>()
  const detachHook = chat.onBeforeSend(async () => preparation.promise)
  const request = chat.submit({ sessionId, messageId: 'preparing', text: 'Cancel before admission.' })
  void request.catch(() => {})
  await expect.poll(() => voice.activeTurns.length).toBe(1)
  await output.requestStopSpeaking({ reason: 'manual-chat', sessionId })
  preparation.resolve()
  await expect(request).rejects.toThrow('cancelled before sending')
  expect(transport.sends).not.toHaveBeenCalled()
  await expect.poll(() => voice.activeTurns.length).toBe(0)
  detachHook()
})
