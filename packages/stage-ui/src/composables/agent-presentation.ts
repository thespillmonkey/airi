import type { PresentationCapabilities, PresentationCommand, PresentationProfile, PresentationResult, PresentationSettings, PresentationState, VoiceSelection } from '@proj-airi/openclaw-bridge'
import type { Live2DContext } from '@proj-airi/stage-ui-live2d/contexts/live2d'
import type { Ref } from 'vue'

import { errorMessageFrom } from '@moeru/std'
import { presentationProfileSchema, presentationStateSchema } from '@proj-airi/openclaw-bridge'
import { useSettingsLive2d } from '@proj-airi/stage-ui-live2d/composables/live2d'
import { useL2dViewControl } from '@proj-airi/stage-ui-live2d/stores'
import { until } from '@vueuse/core'
import { nextTick, ref, toRaw } from 'vue'

import * as v from 'valibot'

import { useAgentModeStore } from '../stores/agent-mode'
import { DisplayModelFormat, useDisplayModelsStore } from '../stores/display-models'
import { useAiriCardStore } from '../stores/modules/airi-card'
import { useHearingStore } from '../stores/modules/hearing'
import { useSpeechStore } from '../stores/modules/speech'
import { useProviderStore } from '../stores/providers/provider'
import { useSettingsAudioDevice } from '../stores/settings/audio-device'
import { useSettingsStageModel } from '../stores/settings/stage-model'
import { useSpeechOutputControlStore } from '../stores/speech-output-control'

/** Stage-owned render state and runtime controls, not a second renderer or character identity. */
export interface AgentPresentationStage {
  state: Ref<'pending' | 'loading' | 'mounted'>
  error: Ref<Error | undefined>
  live2d: Live2DContext
  stopSpeech: () => Promise<void>
}

/** Applies transactional presentation changes to the same stores that manual controls read. */
export function useAgentPresentation(stage: AgentPresentationStage) {
  const agentMode = useAgentModeStore()
  const models = useDisplayModelsStore()
  const cards = useAiriCardStore()
  const model = useSettingsStageModel()
  const speech = useSpeechStore()
  const providers = useProviderStore()
  const hearing = useHearingStore()
  const microphone = useSettingsAudioDevice()
  const playback = useSpeechOutputControlStore()
  const live2d = useSettingsLive2d()
  const view = useL2dViewControl()
  const profileId = ref<string>()
  let revision = 0
  let queue = Promise.resolve()
  function storedValue(key: string): unknown {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null')
    }
    catch { return null }
  }
  const rawSpeechSchema = v.strictObject({ provider: v.string(), model: v.string(), voice: v.string() })
  const rawSpeechResult = v.safeParse(rawSpeechSchema, storedValue('openclaw/normal-speech'))
  let normalSpeech = rawSpeechResult.success ? rawSpeechResult.output : undefined
  const baselineResult = v.safeParse(presentationStateSchema, storedValue('openclaw/normal-presentation'))
  let baseline: PresentationState | undefined = baselineResult.success ? baselineResult.output : undefined
  const profileResult = v.safeParse(v.array(presentationProfileSchema), storedValue('openclaw/presentation-profiles'))
  const profiles = ref<PresentationProfile[]>(profileResult.success ? profileResult.output : [])

  function readVoice(): VoiceSelection | undefined {
    if (!speech.activeSpeechProvider || !speech.activeSpeechModel || !speech.activeSpeechVoiceId)
      return undefined
    return { providerId: speech.activeSpeechProvider, modelId: speech.activeSpeechModel, voiceId: speech.activeSpeechVoiceId }
  }

  function state(): PresentationState {
    const settings: PresentationSettings = {
      speechVolume: playback.speechVolume,
      speechMuted: playback.speechMuted,
      microphoneMuted: !microphone.enabled,
      inputDeviceId: microphone.selectedAudioInput || undefined,
      listeningMode: hearing.inputMode,
    }
    if (model.stageModelRenderer === 'live2d') {
      settings.avatarScale = view.scale.value
      settings.avatarX = view.position.value.x
      settings.avatarY = view.position.value.y
      settings.idleAnimation = live2d.live2dIdleAnimationEnabled
    }
    return { revision, avatarId: model.stageModelSelected || undefined, voice: readVoice(), settings, profileId: profileId.value, scope: 'client' }
  }

  async function capabilities(): Promise<PresentationCapabilities> {
    await models.loadDisplayModelsFromIndexedDB()
    const controls: PresentationCapabilities['activeAvatarControls'] = []
    if (model.stageModelRenderer === 'live2d') {
      controls.push(...stage.live2d.expressions.enabled.value.map(item => ({ id: `expression:${item.name}`, name: item.name, kind: 'expression' as const })))
      controls.push(...stage.live2d.motions.enabled.value.map(item => ({ id: `motion:${item.fileName}`, name: item.fileName, kind: 'motion' as const })))
    }
    const configured = providers.configuredSpeechProvidersMetadata
    const voices: PresentationCapabilities['voices'] = []
    const ttsProviders: PresentationCapabilities['ttsProviders'] = []
    for (const provider of configured) {
      const catalog = speech.getVoicesForProvider(provider.id)
      const configuredVoice = readVoice()
      const configuredCatalog = agentMode.configuredVoices.filter(item => item.providerId === provider.id)
      const providerModels = providers.getModelsForProvider(provider.id)
      ttsProviders.push({ id: provider.id, name: provider.name, models: providerModels.map(item => ({ id: item.id, name: item.name })), voiceDiscovery: catalog.length ? 'provider' : 'configured', limitation: catalog.length ? undefined : 'This provider has no loaded discovery catalog. Voices come from the explicit configured catalog or current selection.' })
      const modelId = speech.voiceCatalogIdentities[provider.id]?.model
      if (!catalog.length)
        voices.push(...configuredCatalog.map(item => ({ id: item.voiceId, name: item.voiceId, providerId: item.providerId, modelId: item.modelId, parameters: [] })))
      if (!catalog.length && configuredVoice?.providerId === provider.id && !configuredCatalog.some(item => item.modelId === configuredVoice.modelId && item.voiceId === configuredVoice.voiceId))
        voices.push({ id: configuredVoice.voiceId, name: configuredVoice.voiceId, providerId: provider.id, modelId: configuredVoice.modelId, parameters: [] })
      if (!modelId)
        continue
      voices.push(...catalog.map(voice => ({ id: voice.id, name: voice.name, providerId: provider.id, modelId, parameters: [] })))
    }
    const live2dActive = model.stageModelRenderer === 'live2d'
    return {
      avatars: models.displayModels.map(item => ({ id: item.id, name: item.name, format: item.format, available: item.format !== DisplayModelFormat.Live2dDirectory, controls: item.id === model.stageModelSelected ? controls : [] })),
      voices,
      ttsProviders,
      settings: [
        { key: 'speechVolume', type: 'number', supported: true, min: 0, max: 1 },
        { key: 'speechMuted', type: 'boolean', supported: true },
        { key: 'microphoneMuted', type: 'boolean', supported: true },
        { key: 'inputDeviceId', type: 'enum', supported: true, values: microphone.audioInputs.map(item => item.deviceId) },
        { key: 'listeningMode', type: 'enum', supported: true, values: ['always-on', 'push-to-talk', 'wake-word'] },
        { key: 'avatarScale', type: 'number', supported: live2dActive, min: 0.01, max: 3 },
        { key: 'avatarX', type: 'number', supported: live2dActive, min: -500, max: 500 },
        { key: 'avatarY', type: 'number', supported: live2dActive, min: -500, max: 500 },
        { key: 'idleAnimation', type: 'boolean', supported: live2dActive },
        { key: 'outputDeviceId', type: 'string', supported: false, reason: 'Output routing is not implemented.' },
        { key: 'sttLanguage', type: 'string', supported: false, reason: 'Language is configured by the STT provider.' },
        { key: 'transcriptVisible', type: 'boolean', supported: false, reason: 'This client does not expose transcript visibility.' },
      ],
      profileScopes: ['client'],
      activeAvatarControls: controls,
    }
  }

  async function applySettings(settings: PresentationSettings) {
    const catalog = await capabilities()
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined)
        continue
      const setting = catalog.settings.find(item => item.key === key)
      if (!setting?.supported)
        throw new Error(`Unsupported setting: ${key}`)
      if (typeof value === 'number' && (!Number.isFinite(value) || (setting.min !== undefined && value < setting.min) || (setting.max !== undefined && value > setting.max)))
        throw new Error(`Setting is outside its range: ${key}`)
      if (setting.values && !setting.values.includes(String(value)))
        throw new Error(`Unavailable setting value: ${key}`)
    }
    if (settings.speechVolume !== undefined)
      playback.setSpeechVolume(settings.speechVolume)
    if (settings.speechMuted !== undefined)
      playback.setSpeechMuted(settings.speechMuted)
    if (settings.microphoneMuted !== undefined) {
      if (!settings.microphoneMuted && !await microphone.askPermission())
        throw new Error('Microphone permission is unavailable')
      microphone.enabled = !settings.microphoneMuted
    }
    if (settings.inputDeviceId !== undefined)
      microphone.selectedAudioInput = settings.inputDeviceId
    if (settings.listeningMode !== undefined)
      hearing.inputMode = settings.listeningMode
    if (settings.avatarScale !== undefined)
      view.set('scale', settings.avatarScale)
    if (settings.avatarX !== undefined)
      view.set('x', settings.avatarX)
    if (settings.avatarY !== undefined)
      view.set('y', settings.avatarY)
    if (settings.idleAnimation !== undefined)
      live2d.live2dIdleAnimationEnabled = settings.idleAnimation
  }

  async function selectAvatar(id: string) {
    if (model.stageModelRenderer === 'godot')
      throw new Error('Avatar switching is not supported while the Godot renderer is active')
    if (id === model.stageModelSelected && stage.state.value === 'mounted' && !stage.error.value)
      return
    if (!await models.getDisplayModel(id))
      throw new Error('The selected avatar is not available on this client')
    await stage.stopSpeech()
    stage.state.value = 'loading'
    model.stageModelSelected = id
    await model.updateStageModel()
    await nextTick()
    if (model.stageModelUnavailable || !model.stageModelSelectedUrl || model.stageModelRenderer === 'disabled')
      throw new Error('The selected avatar format cannot render on this client')
    await until(() => stage.state.value === 'mounted' || Boolean(stage.error.value)).toBe(true, { timeout: 15000, throwOnTimeout: true })
    if (stage.error.value)
      throw new Error(stage.error.value.message)
  }

  async function selectVoice(voice: VoiceSelection) {
    if (voice.parameters && Object.keys(voice.parameters).length)
      throw new Error('Voice rate and pitch changes are not verified for this adapter')
    if (!providers.configuredSpeechProvidersMetadata.some(item => item.id === voice.providerId))
      throw new Error('The TTS provider is not configured')
    const configured = readVoice()
    const knownModels = providers.getModelsForProvider(voice.providerId)
    const matchesConfigured = (configured?.providerId === voice.providerId && configured.modelId === voice.modelId && configured.voiceId === voice.voiceId)
      || agentMode.configuredVoices.some(item => item.providerId === voice.providerId && item.modelId === voice.modelId && item.voiceId === voice.voiceId)
    if (knownModels.length && !knownModels.some(item => item.id === voice.modelId))
      throw new Error('The TTS model is unavailable in the configured provider catalog')
    await speech.loadVoicesForProvider(voice.providerId, voice.modelId)
    const available = speech.getVoicesForProvider(voice.providerId)
    if (!available.some(item => item.id === voice.voiceId) && (available.length !== 0 || !matchesConfigured))
      throw new Error('The requested voice is unavailable in the configured provider catalog')
    await providers.getProviderInstance(voice.providerId)
    await stage.stopSpeech()
    await speech.selectProviderModel(voice.providerId, voice.modelId, voice.voiceId)
    if (speech.activeSpeechVoiceId !== voice.voiceId)
      throw new Error('The TTS provider did not retain the requested voice')
  }

  async function apply(next: PresentationState) {
    if (next.avatarId && next.avatarId !== model.stageModelSelected) {
      await selectAvatar(next.avatarId)
    }
    else if (!next.avatarId && model.stageModelSelected) {
      model.stageModelSelected = ''
      await model.updateStageModel()
    }
    if (next.voice)
      await speech.selectProviderModel(next.voice.providerId, next.voice.modelId, next.voice.voiceId)
    else
      await speech.selectProviderModel('speech-noop', '', '')
    await applySettings(next.settings)
    profileId.value = next.profileId
  }

  async function begin() {
    if (baseline)
      return
    baseline = state()
    normalSpeech = { provider: speech.activeSpeechProvider, model: speech.activeSpeechModel, voice: speech.activeSpeechVoiceId }
    localStorage.setItem('openclaw/normal-speech', JSON.stringify(normalSpeech))
    localStorage.setItem('openclaw/normal-presentation', JSON.stringify(baseline))
    const effective = cards.getModules(cards.activeCardId).speech
    await speech.selectProviderModel(effective.provider, effective.model, effective.voice_id)
  }

  async function restore() {
    if (!baseline)
      return
    await stage.stopSpeech()
    await apply(baseline)
    if (normalSpeech)
      await speech.selectProviderModel(normalSpeech.provider, normalSpeech.model, normalSpeech.voice)
    normalSpeech = undefined
    localStorage.removeItem('openclaw/normal-speech')
    baseline = undefined
    profileId.value = undefined
    localStorage.removeItem('openclaw/normal-presentation')
  }

  async function perform(command: PresentationCommand): Promise<PresentationResult> {
    if ('scope' in command && command.scope && command.scope !== 'client')
      throw new Error('This client supports client-scoped presentation changes only')
    const previous = state()
    const previousSpeech = { provider: speech.activeSpeechProvider, model: speech.activeSpeechModel, voice: speech.activeSpeechVoiceId }
    try {
      switch (command.operation) {
        case 'avatar.select':
          await selectAvatar(command.avatarId)
          break
        case 'voice.select':
          await selectVoice(command.voice)
          break
        case 'settings.update':
          await applySettings(command.settings)
          break
        case 'settings.restore':
          if (!baseline)
            throw new Error('No previous presentation was captured')
          await applySettings(baseline.settings)
          break
        case 'presentation.restore':
          if (!baseline)
            throw new Error('No previous presentation was captured')
          await apply(baseline)
          if (normalSpeech)
            await speech.selectProviderModel(normalSpeech.provider, normalSpeech.model, normalSpeech.voice)
          break
        case 'avatar.control': {
          const control = (await capabilities()).activeAvatarControls.find(item => item.id === command.controlId)
          if (!control)
            throw new Error('This avatar does not support the requested control')
          const accepted = control.kind === 'expression'
            ? await stage.live2d.expressions.execute({ name: control.name, duration: (command.durationMs ?? 3000) / 1000 })
            : await stage.live2d.motions.execute(control.name)
          if (!accepted)
            throw new Error('The avatar rejected this control')
          break
        }
        case 'voices.list':
          if (command.providerId)
            await speech.loadVoicesForProvider(command.providerId, command.modelId)
          break
        case 'profile.save': {
          const saved: PresentationProfile = { id: command.profileId ?? crypto.randomUUID(), name: command.name, scope: 'client', state: previous }
          const next = [...profiles.value.filter(item => item.id !== saved.id), saved]
          localStorage.setItem('openclaw/presentation-profiles', JSON.stringify(toRaw(next)))
          profiles.value = next
          profileId.value = saved.id
          break
        }
        case 'profile.apply': {
          const profile = profiles.value.find(item => item.id === command.profileId)
          if (!profile)
            throw new Error('The presentation profile is unavailable')
          if (profile.state.voice)
            await selectVoice(profile.state.voice)
          await apply(profile.state)
          profileId.value = profile.id
          break
        }
        case 'profile.delete': {
          const next = profiles.value.filter(item => item.id !== command.profileId)
          localStorage.setItem('openclaw/presentation-profiles', JSON.stringify(toRaw(next)))
          profiles.value = next
          if (profileId.value === command.profileId)
            profileId.value = undefined
          break
        }
      }
      revision += 1
      return { ok: true, state: state(), capabilities: await capabilities(), profiles: toRaw(profiles.value) }
    }
    catch (cause) {
      // A failed transaction restores the previous effective selection before reporting failure.
      try {
        await apply(previous)
        await speech.selectProviderModel(previousSpeech.provider, previousSpeech.model, previousSpeech.voice)
      }
      catch (rollback) { throw new Error(`Presentation failed and rollback failed: ${String(cause)}. ${String(rollback)}`) }
      throw cause
    }
  }

  async function execute(command: PresentationCommand): Promise<PresentationResult> {
    const operation = queue.then(() => perform(command))
    queue = operation.then(() => {}, () => {})
    return operation.catch((cause: unknown) => ({ ok: false, error: errorMessageFrom(cause) ?? 'Presentation change failed', state: state() }))
  }

  return { begin, restore, execute, readVoice }
}
