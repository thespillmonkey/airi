import type { SpeechInputAttempt, TranscriptionEvent } from '@proj-airi/core-agent'
import type { PcmBlock } from '@proj-airi/pipelines-audio'

import { VoiceController } from '@proj-airi/core-agent'
import { AudioInput } from '@proj-airi/pipelines-audio'
import { createPushStream } from '@proj-airi/stream-kit'
import { expect, it, vi } from 'vitest'

import { createAgentSpeechGate } from './agent-speech-gate'
import { createVoiceActivityPlugin } from './voice-activity-plugin'

it('rejects automatic own-output with AEC enabled before custom acceptance, through drain and hangover', async () => {
  let active = true
  let now = 0
  const gate = createAgentSpeechGate({ active: () => active, now: () => now })
  const platformAEC = vi.fn(() => true)
  gate.outputStarted('answer')
  expect(await gate.acceptAutomatic(platformAEC)).toBe(false)
  expect(platformAEC).not.toHaveBeenCalled()
  gate.outputFinished('answer')
  now = 399
  expect(await gate.acceptAutomatic(platformAEC)).toBe(false)
  now = 401
  expect(await gate.acceptAutomatic(platformAEC)).toBe(true)
  active = false
  gate.outputStarted('normal-mode-answer')
  expect(await gate.acceptAutomatic(platformAEC)).toBe(true)
})

it('rejects an asynchronous detector admission if output begins during its decision', async () => {
  const gate = createAgentSpeechGate({ active: () => true })
  const decision = Promise.withResolvers<boolean>()
  const accepted = gate.acceptAutomatic(() => decision.promise)
  gate.outputStarted('answer')
  decision.resolve(true)
  expect(await accepted).toBe(false)
})

it('rejects an asynchronous VAD decision after leaving Agent Mode, including a round trip', async () => {
  let active = true
  let epoch = 0
  const gate = createAgentSpeechGate({ active: () => active, captureContext: () => {
    const captured = epoch
    return () => captured === epoch
  } })
  const decision = Promise.withResolvers<boolean>()
  const accepted = gate.acceptAutomatic(() => decision.promise)
  active = false
  epoch += 1
  decision.resolve(true)
  expect(await accepted).toBe(false)
  active = true
  const again = Promise.withResolvers<boolean>()
  const roundTrip = gate.acceptAutomatic(() => again.promise)
  active = false
  epoch += 1
  active = true
  epoch += 1
  again.resolve(true)
  expect(await roundTrip).toBe(false)
})

it('prevents a pre-existing automatic VAD input from submitting self-output but preserves explicit controls', async () => {
  const source = createPushStream<PcmBlock>()
  const audio = new AudioInput({ live: true, open: () => source.stream })
  let now = 0
  const gate = createAgentSpeechGate({ active: () => true, now: () => now })
  const automatic = new Map<string, () => boolean>()
  const submitted = vi.fn(async () => ({ status: 'committed' as const, messageId: 'human' }))
  let attempt: SpeechInputAttempt | undefined
  const controller = new VoiceController({ audio, submit: async (submission) => {
    if (automatic.get(submission.submissionId)?.() === false) {
      attempt!.cancel('Agent output overlapped automatic input')
      throw new DOMException('Agent output overlapped automatic input', 'AbortError')
    }
    return submitted()
  }, transcriber: () => ({ transcribe: request => new ReadableStream<TranscriptionEvent>({ async start(output) {
    await request.audio.pipeTo(new WritableStream())
    output.enqueue({ type: 'update', revision: 1, segments: [{ id: 'text', revision: 1, text: 'Recognized audio', final: true, tokens: [] }] })
    output.enqueue({ type: 'complete', revision: 1 })
    output.close()
  } }) }) })
  controller.onInput((input) => {
    attempt = input
    if (input.cause !== 'control')
      automatic.set(input.id, gate.captureAutomatic())
  })
  controller.use(createVoiceActivityPlugin({ detect: async window => window.channels[0][0], target: () => ({ sessionId: 'same-session', interruptTurns: [] }), acceptSpeech: () => gate.acceptAutomatic(() => true), minSpeechMs: 32, silenceMs: 64 }), { grants: ['input-control', 'cancel-input'] })
  await Promise.resolve()
  const push = (start: number, value: number) => source.write({ range: { sourceId: 'mic', startFrame: start, endFrame: start + 32 }, sampleRate: 1000, channels: [new Float32Array(32).fill(value)] })
  push(0, 1)
  await expect.poll(() => attempt?.state.phase).toBe('capturing')
  gate.outputStarted('reply')
  push(32, 0)
  push(64, 0)
  expect(await attempt!.done).toEqual({ status: 'cancelled', reason: 'Agent output overlapped automatic input' })
  expect(submitted).not.toHaveBeenCalled()
  gate.outputFinished('reply')
  now = 401
  push(96, 1)
  await expect.poll(() => attempt?.state.phase).toBe('capturing')
  push(128, 0)
  push(160, 0)
  expect(await attempt!.done).toEqual({ status: 'committed', messageId: 'human' })
  gate.outputStarted('next-reply')
  const manual = controller.beginInput({ sessionId: 'same-session', cause: 'control', interruptTurns: [], start: { kind: 'after-silence' } })
  push(192, 1)
  await expect.poll(() => manual.state.phase).toBe('capturing')
  manual.end()
  expect(await manual.done).toEqual({ status: 'committed', messageId: 'human' })
  expect(submitted).toHaveBeenCalledTimes(2)
  await controller.close()
})
