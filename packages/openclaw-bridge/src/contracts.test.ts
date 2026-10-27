import { describe, expect, it } from 'vitest'

import { decodeClientMessage, decodeServerMessage, encodeClientMessage, encodeServerMessage } from './contracts'

describe('authenticated bridge contract', () => {
  it('preserves typed and voice submission identity in Eventa frames', () => {
    const value = { version: 1 as const, type: 'user.message' as const, messageId: 'turn-1', text: 'Hello', input: 'voice' as const }
    const encoded = encodeClientMessage(value)
    expect(JSON.parse(encoded).id).toBe('airi:openclaw:v1:client')
    expect(decodeClientMessage(encoded)).toEqual(value)
  })

  it('rejects cross-direction frame injection and extra routing authority', () => {
    const server = encodeServerMessage({ version: 1, type: 'response.final', messageId: 'turn-1', text: 'Done', sequence: 1 })
    expect(() => decodeClientMessage(server)).toThrow()
    const client = encodeClientMessage({ version: 1, type: 'user.message', messageId: 'turn-1', text: 'Hello', input: 'text' })
    const hostile = JSON.parse(client)
    hostile.body.sessionKey = 'agent:other:main'
    expect(() => decodeClientMessage(JSON.stringify(hostile))).toThrow()
  })

  it('validates actual control limits before transmission', () => {
    expect(() => encodeServerMessage({ version: 1, type: 'presentation.request', actionId: 'action-1', command: { operation: 'settings.update', settings: { speechVolume: 2 } } })).toThrow()
    expect(() => encodeServerMessage({ version: 1, type: 'presentation.request', actionId: 'action-1', command: { operation: 'avatar.control', controlId: 'smile', durationMs: 60001 } })).toThrow()
  })

  it('rejects unknown settings and credential-bearing presentation profiles', () => {
    const frame = { id: 'airi:openclaw:v1:server', type: 'event', body: { version: 1, type: 'presentation.request', actionId: 'action-1', command: { operation: 'voice.select', voice: { providerId: 'local', modelId: 'tts', voiceId: 'one', apiKey: 'not-a-real-key' } } } }
    expect(() => decodeServerMessage(JSON.stringify(frame))).toThrow()
    const invalidSettings = { ...frame, body: { ...frame.body, command: { operation: 'settings.update', settings: { arbitraryProviderOption: 'x' } } } }
    expect(() => decodeServerMessage(JSON.stringify(invalidSettings))).toThrow()
  })

  it('bounds network frame size before JSON parsing', () => {
    expect(() => decodeServerMessage('x'.repeat(1048577))).toThrow('exceeds 1 MiB')
  })

  it('keeps command and approval metadata separate from spoken response text', () => {
    const action = decodeServerMessage(encodeServerMessage({ version: 1, type: 'presentation.request', actionId: 'action-1', command: { operation: 'avatar.select', avatarId: 'model-2' } }))
    expect(action.type).toBe('presentation.request')
    expect('text' in action).toBe(false)
    const approval = decodeServerMessage(encodeServerMessage({ version: 1, type: 'approval.request', approvalId: 'approval-1', kind: 'exec', description: 'Run the approved tool', allowedDecisions: ['deny'] }))
    expect(approval.type).toBe('approval.request')
    expect('text' in approval).toBe(false)
  })
})
