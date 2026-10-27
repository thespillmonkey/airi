import { defineEventa } from '@moeru/eventa'

import * as v from 'valibot'

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(256))
const text = v.pipe(v.string(), v.maxLength(131072))
const scope = v.picklist(['client', 'conversation', 'agent', 'application'])
const parameter = v.strictObject({ rate: v.optional(v.number()), pitch: v.optional(v.number()) })

export const voiceSelectionSchema = v.strictObject({
  providerId: id,
  modelId: id,
  voiceId: id,
  parameters: v.optional(parameter),
})
export type VoiceSelection = v.InferOutput<typeof voiceSelectionSchema>

export const presentationSettingsSchema = v.strictObject({
  speechVolume: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  speechMuted: v.optional(v.boolean()),
  microphoneMuted: v.optional(v.boolean()),
  inputDeviceId: v.optional(id),
  outputDeviceId: v.optional(id),
  sttLanguage: v.optional(id),
  listeningMode: v.optional(v.picklist(['always-on', 'push-to-talk', 'wake-word'])),
  transcriptVisible: v.optional(v.boolean()),
  avatarScale: v.optional(v.number()),
  avatarX: v.optional(v.number()),
  avatarY: v.optional(v.number()),
  idleAnimation: v.optional(v.boolean()),
})
export type PresentationSettings = v.InferOutput<typeof presentationSettingsSchema>
export type PresentationScope = v.InferOutput<typeof scope>

export const presentationStateSchema = v.strictObject({
  revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  avatarId: v.optional(id),
  voice: v.optional(voiceSelectionSchema),
  settings: presentationSettingsSchema,
  profileId: v.optional(id),
  scope,
})
export type PresentationState = v.InferOutput<typeof presentationStateSchema>

const controlSchema = v.strictObject({
  id,
  name: id,
  kind: v.picklist(['expression', 'motion', 'gesture', 'gaze', 'pose', 'state']),
  durationMs: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(60000))),
})
const avatarSchema = v.strictObject({ id, name: id, format: id, available: v.boolean(), controls: v.array(controlSchema) })
const voiceSchema = v.strictObject({
  id,
  name: id,
  providerId: id,
  modelId: id,
  language: v.optional(id),
  custom: v.optional(v.boolean()),
  parameters: v.array(v.strictObject({ key: v.picklist(['rate', 'pitch']), min: v.number(), max: v.number(), default: v.optional(v.number()) })),
})
const providerSchema = v.strictObject({
  id,
  name: id,
  models: v.array(v.strictObject({ id, name: id })),
  voiceDiscovery: v.picklist(['provider', 'configured', 'unavailable']),
  limitation: v.optional(text),
})
const settingSchema = v.strictObject({
  key: v.keyof(presentationSettingsSchema),
  type: v.picklist(['boolean', 'number', 'string', 'enum']),
  supported: v.boolean(),
  min: v.optional(v.number()),
  max: v.optional(v.number()),
  values: v.optional(v.array(v.string())),
  reason: v.optional(text),
})
export const presentationCapabilitiesSchema = v.strictObject({
  avatars: v.array(avatarSchema),
  voices: v.array(voiceSchema),
  ttsProviders: v.array(providerSchema),
  settings: v.array(settingSchema),
  profileScopes: v.array(scope),
  activeAvatarControls: v.array(controlSchema),
})
export type PresentationCapabilities = v.InferOutput<typeof presentationCapabilitiesSchema>

export const presentationProfileSchema = v.strictObject({
  id,
  name: id,
  scope,
  agentId: v.optional(id),
  conversationId: v.optional(id),
  state: presentationStateSchema,
})
export type PresentationProfile = v.InferOutput<typeof presentationProfileSchema>

/** Commands select configured presentation resources, never credentials or routing authority. */
export const presentationCommandSchema = v.variant('operation', [
  v.strictObject({ operation: v.literal('state.read') }),
  v.strictObject({ operation: v.literal('avatars.list') }),
  v.strictObject({ operation: v.literal('avatar.select'), avatarId: id, scope: v.optional(scope) }),
  v.strictObject({ operation: v.literal('avatar.control'), controlId: id, durationMs: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(60000))) }),
  v.strictObject({ operation: v.literal('voices.list'), providerId: v.optional(id), modelId: v.optional(id) }),
  v.strictObject({ operation: v.literal('voice.select'), voice: voiceSelectionSchema, scope: v.optional(scope) }),
  v.strictObject({ operation: v.literal('settings.update'), settings: presentationSettingsSchema, scope: v.optional(scope) }),
  v.strictObject({ operation: v.literal('settings.restore') }),
  v.strictObject({ operation: v.literal('profiles.list') }),
  v.strictObject({ operation: v.literal('profile.save'), name: id, profileId: v.optional(id), scope }),
  v.strictObject({ operation: v.literal('profile.apply'), profileId: id }),
  v.strictObject({ operation: v.literal('profile.delete'), profileId: id }),
  v.strictObject({ operation: v.literal('presentation.restore') }),
])
export type PresentationCommand = v.InferOutput<typeof presentationCommandSchema>

const common = { version: v.literal(1) }
export const clientMessageSchema = v.variant('type', [
  v.strictObject({ ...common, type: v.literal('hello'), token: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)), clientId: id, conversationId: id, agentId: id, lastSequence: v.optional(v.number()) }),
  v.strictObject({ ...common, type: v.literal('user.message'), messageId: id, text, input: v.picklist(['text', 'voice']) }),
  v.strictObject({ ...common, type: v.literal('turn.cancel'), messageId: id }),
  v.strictObject({ ...common, type: v.literal('capabilities.update'), capabilities: presentationCapabilitiesSchema, state: presentationStateSchema }),
  v.strictObject({ ...common, type: v.literal('presentation.result'), actionId: id, ok: v.boolean(), state: v.optional(presentationStateSchema), capabilities: v.optional(presentationCapabilitiesSchema), profiles: v.optional(v.array(presentationProfileSchema)), error: v.optional(text) }),
  v.strictObject({ ...common, type: v.literal('approval.resolve'), approvalId: id, decision: v.picklist(['allow-once', 'allow-always', 'deny']) }),
])
export type ClientMessage = v.InferOutput<typeof clientMessageSchema>

const sequence = v.pipe(v.number(), v.integer(), v.minValue(0))
export const serverMessageSchema = v.variant('type', [
  v.strictObject({ ...common, type: v.literal('ready'), connectionId: id, sessionKey: id, agentId: id, agents: v.array(v.strictObject({ id, name: id })), capabilities: v.optional(presentationCapabilitiesSchema) }),
  v.strictObject({ ...common, type: v.literal('response.accepted'), messageId: id, sessionKey: id, sequence }),
  v.strictObject({ ...common, type: v.literal('response.delta'), messageId: id, text, sequence }),
  v.strictObject({ ...common, type: v.literal('response.final'), messageId: id, text, sequence }),
  v.strictObject({ ...common, type: v.literal('response.cancelled'), messageId: id, sequence }),
  v.strictObject({ ...common, type: v.literal('response.error'), messageId: v.optional(id), code: id, message: text, sequence }),
  v.strictObject({ ...common, type: v.literal('presentation.request'), actionId: id, command: presentationCommandSchema }),
  v.strictObject({ ...common, type: v.literal('approval.request'), approvalId: id, kind: id, description: text, expiresAt: v.optional(v.number()), allowedDecisions: v.optional(v.array(v.picklist(['allow-once', 'allow-always', 'deny']))) }),
  v.strictObject({ ...common, type: v.literal('approval.resolved'), approvalId: id, status: v.picklist(['resolved', 'expired', 'cancelled']), decision: v.optional(v.picklist(['allow-once', 'allow-always', 'deny'])), applicationStatus: v.optional(v.picklist(['applied', 'not-applied'])), sequence }),
  v.strictObject({ ...common, type: v.literal('status'), state: v.picklist(['thinking', 'listening', 'speaking', 'idle', 'disconnected']), sequence }),
])
export type ServerMessage = v.InferOutput<typeof serverMessageSchema>

/** Separate Eventa channels prevent a client frame from being accepted as a server event. */
export const clientEvent = defineEventa<ClientMessage>('airi:openclaw:v1:client')
export const serverEvent = defineEventa<ServerMessage>('airi:openclaw:v1:server')
const clientEnvelope = v.strictObject({ id: v.literal(clientEvent.id), type: v.literal('event'), body: clientMessageSchema })
const serverEnvelope = v.strictObject({ id: v.literal(serverEvent.id), type: v.literal('event'), body: serverMessageSchema })

function parseFrame(frame: string): unknown {
  if (frame.length > 1048576)
    throw new Error('Bridge frame exceeds 1 MiB')
  return JSON.parse(frame)
}

/** Validate both outbound and inbound frames at the untrusted network boundary. */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(v.parse(clientEnvelope, { id: clientEvent.id, type: 'event', body: message }))
}
export function decodeClientMessage(frame: string): ClientMessage {
  return v.parse(clientEnvelope, parseFrame(frame)).body
}
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(v.parse(serverEnvelope, { id: serverEvent.id, type: 'event', body: message }))
}
export function decodeServerMessage(frame: string): ServerMessage {
  return v.parse(serverEnvelope, parseFrame(frame)).body
}
