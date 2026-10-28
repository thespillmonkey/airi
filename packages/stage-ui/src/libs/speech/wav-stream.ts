import type { PcmBlock } from '@proj-airi/pipelines-audio'

import { nanoid } from 'nanoid/non-secure'

/** Decodes PCM16 WAV incrementally. Network chunks can split headers, samples, or interleaved channel frames. */
export function decodeWavStream(bytes: ReadableStream<Uint8Array>): ReadableStream<PcmBlock> {
  const decoder = new WavDecoder()
  return bytes.pipeThrough(new TransformStream<Uint8Array, PcmBlock>({
    transform: (chunk, output) => decoder.push(chunk, output),
    flush: () => decoder.finish(),
  }))
}

/** Header bytes are bounded. Once data starts, only an incomplete PCM frame survives between network chunks. */
class WavDecoder {
  private pending = new Uint8Array(0)
  private riff = false
  private format = false
  private data = false
  private channels = 0
  private sampleRate = 0
  private frame = 0
  private remaining = Infinity
  private readonly sourceId = nanoid()

  push(chunk: Uint8Array, output: TransformStreamDefaultController<PcmBlock>) {
    if (this.data && this.remaining === 0)
      return
    const joined = new Uint8Array(this.pending.length + chunk.length)
    joined.set(this.pending)
    joined.set(chunk, this.pending.length)
    this.pending = joined

    if (!this.riff) {
      if (this.pending.length < 12)
        return
      if (this.tag(0) !== 'RIFF' || this.tag(8) !== 'WAVE')
        throw new Error('Streaming speech requires a WAV response')
      this.pending = this.pending.slice(12)
      this.riff = true
    }

    while (!this.data) {
      if (this.pending.length < 8)
        return
      const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength)
      const tag = this.tag(0)
      const size = view.getUint32(4, true)
      if (tag === 'data') {
        if (!this.format)
          throw new Error('WAV data arrived before its format')
        // Studio uses UINT32_MAX because synthesis has not finished when it sends the header.
        this.remaining = size === 0xFFFFFFFF ? Infinity : size
        this.pending = this.pending.slice(8)
        this.data = true
        break
      }
      if (size > 65536)
        throw new Error('Streaming WAV metadata exceeds 64 KiB')
      const length = 8 + size + (size % 2)
      if (this.pending.length < length)
        return
      if (tag === 'fmt ') {
        if (size < 16 || view.getUint16(8, true) !== 1 || view.getUint16(22, true) !== 16)
          throw new Error('Streaming WAV requires PCM16 audio')
        this.channels = view.getUint16(10, true)
        this.sampleRate = view.getUint32(12, true)
        if (this.channels < 1 || this.channels > 8 || !this.sampleRate || view.getUint16(20, true) !== this.channels * 2)
          throw new Error('Streaming WAV has an invalid audio format')
        this.format = true
      }
      this.pending = this.pending.slice(length)
    }

    const frameBytes = this.channels * 2
    const count = Math.floor(Math.min(this.pending.length, this.remaining) / frameBytes)
    if (!count)
      return
    const channels = Array.from({ length: this.channels }, () => new Float32Array(count))
    const view = new DataView(this.pending.buffer, this.pending.byteOffset, count * frameBytes)
    for (let frame = 0; frame < count; frame++) {
      for (let channel = 0; channel < this.channels; channel++)
        channels[channel]![frame] = view.getInt16((frame * this.channels + channel) * 2, true) / 32768
    }
    output.enqueue({ range: { sourceId: this.sourceId, startFrame: this.frame, endFrame: this.frame + count }, sampleRate: this.sampleRate, channels })
    this.frame += count
    this.remaining -= count * frameBytes
    this.pending = this.pending.slice(count * frameBytes)
    // Finite WAV data can have trailing metadata. It does not contain audio frames.
    if (!this.remaining)
      this.pending = new Uint8Array(0)
  }

  finish() {
    if (!this.data || this.pending.length || (Number.isFinite(this.remaining) && this.remaining !== 0))
      throw new Error('Streaming WAV ended with an incomplete header or audio frame')
    if (!this.frame)
      throw new Error('Streaming WAV contains no audio')
  }

  private tag(offset: number) {
    return String.fromCharCode(...this.pending.subarray(offset, offset + 4))
  }
}
