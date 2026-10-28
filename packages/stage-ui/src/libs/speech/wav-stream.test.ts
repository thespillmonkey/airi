import { describe, expect, it } from 'vitest'

import { decodeWavStream } from './wav-stream'

function wav(samples: number[], channels = 1) {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const)
    bytes.set(new TextEncoder().encode(text), offset)
  view.setUint32(4, 0xFFFFFFFF, true)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, 24000, true)
  view.setUint32(28, 48000 * channels, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(40, 0xFFFFFFFF, true)
  samples.forEach((value, index) => view.setInt16(44 + index * 2, value, true))
  return bytes
}

describe('streamed WAV speech', () => {
  // https://discord.com/channels/1489521417572847676/1489521418206183597
  // PCM playback consumes the first body chunk, without waiting for synthesis EOF.
  it('emits playable PCM before the HTTP response completes', async () => {
    let input!: ReadableStreamDefaultController<Uint8Array>
    const bytes = new ReadableStream<Uint8Array>({ start(controller) {
      input = controller
    } })
    const reader = decodeWavStream(bytes).getReader()
    const data = wav([0, 16384, -32768, 32767])
    input.enqueue(data.subarray(0, 48))
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect([...first.value!.channels[0]!]).toEqual([0, 0.5])
    expect(first.value!.range.startFrame).toBe(0)
    expect(first.value!.range.endFrame).toBe(2)
    input.enqueue(data.subarray(48))
    input.close()
    const second = await reader.read()
    expect([...second.value!.channels[0]!]).toEqual([-1, 32767 / 32768])
    expect(second.value!.range.sourceId).toBe(first.value!.range.sourceId)
    expect(second.value!.range.startFrame).toBe(2)
    expect((await reader.read()).done).toBe(true)
  })

  it('preserves stereo frames across single-byte network chunks', async () => {
    const data = wav([16384, -16384, 8192, -8192], 2)
    const chunks = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of data)
        controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } })
    const blocks = await Array.fromAsync(decodeWavStream(chunks))
    expect(blocks.map(block => [...block.channels[0]!])).toEqual([[0.5], [0.25]])
    expect(blocks.map(block => [...block.channels[1]!])).toEqual([[-0.5], [-0.25]])
    expect(blocks[0]!.sampleRate).toBe(24000)
  })

  it('rejects truncated samples and unsupported formats', async () => {
    const truncated = wav([1]).slice(0, -1)
    const bytes = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(truncated)
      controller.close()
    } })
    await expect(Array.fromAsync(decodeWavStream(bytes))).rejects.toThrow('incomplete')
    const invalid = wav([1])
    new DataView(invalid.buffer).setUint16(20, 3, true)
    const format = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(invalid)
      controller.close()
    } })
    await expect(Array.fromAsync(decodeWavStream(format))).rejects.toThrow('PCM16')
  })

  it('cancels the upstream response body when playback is cancelled', async () => {
    let reason: unknown
    const bytes = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(wav([1, 2]))
    }, cancel(value) { reason = value } })
    const reader = decodeWavStream(bytes).getReader()
    await reader.read()
    await reader.cancel('Stop')
    await expect.poll(() => reason).toBe('Stop')
  })
})
