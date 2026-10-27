import type { App } from 'vue'

import en from '@proj-airi/i18n/locales/en'

import { PiniaColada } from '@pinia/colada'
import { createLive2D } from '@proj-airi/stage-ui-live2d/contexts/live2d'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, ref } from 'vue'
import { createI18n } from 'vue-i18n'

import { useAgentModeStore } from '../stores/agent-mode'
import { useAiriCardStore } from '../stores/modules/airi-card'
import { useSpeechStore } from '../stores/modules/speech'
import { useProviderConfigStore } from '../stores/providers/config'
import { useProviderStore } from '../stores/providers/provider'
import { useSpeechOutputControlStore } from '../stores/speech-output-control'
import { useAgentPresentation } from './agent-presentation'

let app: App | undefined
let cleanup: (() => void) | undefined

async function mountPresentation() {
  const pinia = createPinia()
  let presentation!: ReturnType<typeof useAgentPresentation>
  const stopSpeech = vi.fn(async () => {})
  const container = document.createElement('div')
  document.body.append(container)
  app = createApp({
    setup() {
      presentation = useAgentPresentation({ state: ref('mounted'), error: ref(), live2d: createLive2D(), stopSpeech })
      return () => null
    },
  })
  app.use(pinia).use(PiniaColada).use(createI18n({ legacy: false, locale: 'en', messages: { en } })).mount(container)
  cleanup = () => {
    app?.unmount()
    disposePinia(pinia)
    container.remove()
  }
  await useAiriCardStore(pinia).initialize()
  return { pinia, presentation, playback: useSpeechOutputControlStore(pinia), stopSpeech }
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup?.()
  localStorage.clear()
})

describe('stage presentation transactions', () => {
  it('shares effective playback settings with manual controls and restores the captured state', async () => {
    const { presentation, playback } = await mountPresentation()
    playback.setSpeechVolume(0.8)
    await presentation.begin()
    const changed = await presentation.execute({ operation: 'settings.update', settings: { speechVolume: 0.25 } })
    expect(changed.ok).toBe(true)
    expect(playback.speechVolume).toBe(0.25)
    playback.setSpeechVolume(0.6)
    const manual = await presentation.execute({ operation: 'state.read' })
    expect(manual.state?.settings.speechVolume).toBe(0.6)
    await presentation.restore()
    expect(playback.speechVolume).toBe(0.8)
    expect(localStorage.getItem('openclaw/normal-presentation')).toBeNull()
  })

  it('rejects unsupported changes before mutation and preserves the previous working state', async () => {
    const { presentation, playback } = await mountPresentation()
    playback.setSpeechVolume(0.7)
    await presentation.begin()
    const failed = await presentation.execute({ operation: 'settings.update', settings: { speechVolume: 0.2, outputDeviceId: 'missing' } })
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('Unsupported setting')
    expect(playback.speechVolume).toBe(0.7)
    const avatar = await presentation.execute({ operation: 'avatar.select', avatarId: 'missing' })
    expect(avatar.ok).toBe(false)
    expect(playback.speechVolume).toBe(0.7)
  })

  it('persists and reapplies a named client profile without copying provider credentials', async () => {
    const { presentation, playback } = await mountPresentation()
    await presentation.begin()
    playback.setSpeechVolume(0.3)
    const saved = await presentation.execute({ operation: 'profile.save', name: 'Quiet', scope: 'client' })
    const id = saved.profiles?.[0]?.id
    expect(id).toBeDefined()
    playback.setSpeechVolume(0.9)
    const applied = await presentation.execute({ operation: 'profile.apply', profileId: id! })
    expect(applied.ok).toBe(true)
    expect(applied.state?.profileId).toBe(id)
    expect(playback.speechVolume).toBe(0.3)
    const persisted = JSON.parse(localStorage.getItem('openclaw/presentation-profiles')!)
    expect(persisted[0].name).toBe('Quiet')
    expect(persisted[0].scope).toBe('client')
    expect(persisted[0].state.settings.speechVolume).toBe(0.3)
  })

  it('keeps saved profiles unchanged when persistence fails and clears a deleted active profile', async () => {
    const { presentation } = await mountPresentation()
    await presentation.begin()
    const saved = await presentation.execute({ operation: 'profile.save', name: 'Working', scope: 'client' })
    const id = saved.profiles![0]!.id
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key) => {
      if (key === 'openclaw/presentation-profiles')
        throw new Error('Storage full')
    })
    const failedSave = await presentation.execute({ operation: 'profile.save', name: 'Not saved', scope: 'client' })
    expect(failedSave.ok).toBe(false)
    const failedDelete = await presentation.execute({ operation: 'profile.delete', profileId: id })
    expect(failedDelete.ok).toBe(false)
    setItem.mockRestore()
    const listed = await presentation.execute({ operation: 'profiles.list' })
    expect(listed.profiles).toHaveLength(1)
    expect(listed.profiles![0]!.name).toBe('Working')
    const deleted = await presentation.execute({ operation: 'profile.delete', profileId: id })
    expect(deleted.ok).toBe(true)
    expect(deleted.state?.profileId).toBeUndefined()
    expect(deleted.profiles).toEqual([])
  })

  it('discovers and selects an explicitly configured voice when provider discovery is unavailable', async () => {
    const { presentation, pinia } = await mountPresentation()
    await presentation.begin()
    const config = useProviderConfigStore(pinia)
    const provider = await config.addProvider('openai-compatible-audio-speech', { apiKey: '', baseUrl: '', model: 'local-tts', voice: 'configured-voice' })
    config.setProviderStatus(provider.id, 'configured')
    const providers = useProviderStore(pinia)
    await vi.waitFor(() => expect(providers.configuredSpeechProvidersMetadata.some(item => item.id === provider.id)).toBe(true))
    const speech = useSpeechStore(pinia)
    await speech.selectProviderModel(provider.id, 'local-tts', 'configured-voice')
    await useAgentModeStore(pinia).setVoiceCatalog(JSON.stringify([{ providerId: provider.id, modelId: 'local-tts', voiceId: 'second-configured-voice' }]))
    const listed = await presentation.execute({ operation: 'voices.list' })
    expect(listed.capabilities?.voices).toContainEqual(expect.objectContaining({ providerId: provider.id, modelId: 'local-tts', id: 'configured-voice' }))
    expect(listed.capabilities?.ttsProviders.find(item => item.id === provider.id)?.voiceDiscovery).toBe('configured')
    const selected = await presentation.execute({ operation: 'voice.select', voice: { providerId: provider.id, modelId: 'local-tts', voiceId: 'configured-voice' } })
    expect(selected.ok).toBe(true)
    expect(selected.state?.voice?.voiceId).toBe('configured-voice')
    const second = await presentation.execute({ operation: 'voice.select', voice: { providerId: provider.id, modelId: 'local-tts', voiceId: 'second-configured-voice' } })
    expect(second.ok).toBe(true)
    expect(second.state?.voice?.voiceId).toBe('second-configured-voice')
    const invented = await presentation.execute({ operation: 'voice.select', voice: { providerId: provider.id, modelId: 'local-tts', voiceId: 'invented-voice' } })
    expect(invented.ok).toBe(false)
    expect(speech.activeSpeechVoiceId).toBe('second-configured-voice')
  })
})
