// Runs on the audio thread. The playhead sticks to a target position set by
// the gesture (moving exactly as far and as fast as the finger, like dragging
// a shape), only smoothed enough to bridge the gaps between pointer events.
// Sound is rendered as short overlapping windowed grains read at the original
// speed in the direction of motion, so the pitch never changes.
//
// Freeze (optional): while the finger is held still, grains keep spawning
// around the playhead with a little position jitter, stretching that moment
// into a sustained sound instead of falling silent.
//
// Tape mode (advanced): the PCM is read straight at the playhead's speed, like
// scratching a record, so pitch follows speed. A frozen playhead still uses
// grains.
//
// The PCM keeps its own sample rate; `step` converts between source samples
// and output samples, so no resampling pass is needed up front.

import { DEFAULT_SCRUB_PARAMS, type ScrubParams } from './scrubParams'

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

export type WorkletInMessage =
  | { type: 'load'; channels: Float32Array[]; sampleRate: number }
  | { type: 'target'; t: number }
  | { type: 'seek'; t: number }
  | { type: 'play' }
  | { type: 'pause' }
  /** Finger is down (only sent while the freeze option is on). */
  | { type: 'hold'; on: boolean }
  | { type: 'params'; params: ScrubParams }

export type WorkletOutMessage =
  | { type: 'pos'; t: number; rate: number; playing: boolean }
  | { type: 'ended' }

const GAIN_SMOOTH_SECONDS = 0.006
const REPORT_EVERY_BLOCKS = 2
const MAX_GRAINS = 4

const alphaFor = (ms: number) => 1 - Math.exp(-1 / ((Math.max(ms, 0.05) / 1000) * sampleRate))

class ScrubProcessor extends AudioWorkletProcessor {
  private channels: Float32Array[] = []
  private length = 0
  private srcRate = sampleRate
  /** Source samples per output sample. */
  private step = 1
  private pos = 0
  private target = 0
  private rate = 0
  private gain = 0
  private playing = false
  private hold = false
  private lastDir: -1 | 1 = 1
  private blockCount = 0

  private grainLen = 0
  private hop = 0
  private window = new Float32Array(0)
  private overlap = 2
  // Overlapping grain slots: source start, direction (±1), age in samples.
  private readonly grainStart = new Float64Array(MAX_GRAINS)
  private readonly grainDir = new Int8Array(MAX_GRAINS)
  private readonly grainAge = new Int32Array(MAX_GRAINS).fill(-1)
  private nextGrain = 0
  private sinceSpawn = 0

  private followAlpha = 0
  private rateAlpha = 0
  private readonly gainAlpha = 1 - Math.exp(-1 / (GAIN_SMOOTH_SECONDS * sampleRate))
  private silentRate = 0
  private jitterSeconds = 0
  private tape = false

  constructor() {
    super()
    this.setParams(DEFAULT_SCRUB_PARAMS)
    this.port.onmessage = (e: MessageEvent<WorkletInMessage>) => this.handle(e.data)
  }

  private setParams(p: ScrubParams) {
    const overlap = p.overlap >= 4 ? 4 : 2
    const grainLen = Math.max(overlap * 2, Math.round((p.grainMs / 1000) * sampleRate)) & ~3
    if (grainLen !== this.grainLen || overlap !== this.overlap) {
      this.grainLen = grainLen
      this.overlap = overlap
      this.hop = grainLen / overlap
      // Hann windows at hop L/k sum to k/2; scale so the overlap sums to 1.
      const norm = 2 / overlap
      this.window = Float32Array.from(
        { length: grainLen },
        (_, n) => (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / grainLen)) * norm,
      )
      this.grainAge.fill(-1)
      this.nextGrain = 0
      this.sinceSpawn = 0
    }
    this.followAlpha = alphaFor(p.followMs)
    this.rateAlpha = alphaFor(p.smoothMs)
    this.silentRate = Math.max(0.001, p.silentRate)
    this.jitterSeconds = Math.max(0, p.jitterMs) / 1000
    this.tape = p.tape
  }

  private clampPos(samples: number) {
    return Math.min(Math.max(samples, 0), Math.max(this.length - 1, 0))
  }

  private handle(msg: WorkletInMessage) {
    switch (msg.type) {
      case 'load':
        this.channels = msg.channels
        this.length = msg.channels[0]?.length ?? 0
        this.srcRate = msg.sampleRate
        this.step = msg.sampleRate / sampleRate
        this.pos = this.target = this.rate = this.gain = 0
        this.playing = false
        this.grainAge.fill(-1)
        break
      case 'target':
        this.playing = false
        this.target = this.clampPos(msg.t * this.srcRate)
        break
      case 'seek':
        this.pos = this.target = this.clampPos(msg.t * this.srcRate)
        this.rate = 0
        this.gain = 0
        break
      case 'play':
        if (this.pos >= this.length - 1) this.pos = 0
        this.playing = true
        break
      case 'pause':
        this.playing = false
        this.target = this.pos
        break
      case 'hold':
        this.hold = msg.on
        break
      case 'params':
        this.setParams(msg.params)
        break
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const frames = out[0].length
    const src = this.channels
    const last = this.length - 1
    const grains = this.overlap

    if (last < 1) {
      for (const ch of out) ch.fill(0)
      return true
    }

    for (let i = 0; i < frames; i++) {
      // Speed in real-time units (1 = normal playback, negative = backwards).
      const desired = this.playing ? 1 : ((this.target - this.pos) * this.followAlpha) / this.step
      this.rate += (desired - this.rate) * this.rateAlpha

      let pos = this.pos + this.rate * this.step
      if (pos <= 0) {
        pos = 0
        this.rate = 0
      } else if (pos >= last) {
        pos = last
        this.rate = 0
        if (this.playing) {
          this.playing = false
          this.target = last
          this.port.postMessage({ type: 'ended' } satisfies WorkletOutMessage)
        }
      }
      if (this.playing) this.target = pos
      this.pos = pos

      const speed = Math.abs(this.rate)
      if (speed >= this.silentRate) this.lastDir = this.rate < 0 ? -1 : 1
      const frozen = this.hold && !this.playing && speed < this.silentRate
      const gainTarget = frozen || speed >= this.silentRate ? 1 : speed / this.silentRate
      this.gain += (gainTarget - this.gain) * this.gainAlpha

      for (let c = 0; c < out.length; c++) out[c][i] = 0

      if (this.tape && !frozen) {
        // Straight read at the playhead: pitch follows speed.
        const i0 = pos | 0
        const frac = pos - i0
        const i1 = i0 < last ? i0 + 1 : i0
        for (let c = 0; c < out.length; c++) {
          const s = src[c < src.length ? c : 0]
          out[c][i] = (s[i0] + (s[i1] - s[i0]) * frac) * this.gain
        }
        continue
      }

      if (this.sinceSpawn-- <= 0) {
        this.sinceSpawn = this.hop - 1
        const g = this.nextGrain
        this.nextGrain = (g + 1) % grains
        if (frozen) {
          const jitter = (Math.random() * 2 - 1) * this.jitterSeconds * this.srcRate
          this.grainStart[g] = Math.min(Math.max(pos + jitter, 0), last)
          this.grainDir[g] = this.lastDir
        } else {
          this.grainStart[g] = pos
          this.grainDir[g] = this.rate < 0 ? -1 : 1
        }
        this.grainAge[g] = 0
      }

      for (let g = 0; g < grains; g++) {
        const age = this.grainAge[g]
        if (age < 0) continue
        const w = this.window[age] * this.gain
        let p = this.grainStart[g] + this.grainDir[g] * age * this.step
        if (p < 0) p = 0
        else if (p > last) p = last
        const i0 = p | 0
        const frac = p - i0
        const i1 = i0 < last ? i0 + 1 : i0
        for (let c = 0; c < out.length; c++) {
          const s = src[c < src.length ? c : 0]
          out[c][i] += (s[i0] + (s[i1] - s[i0]) * frac) * w
        }
        this.grainAge[g] = age + 1 < this.grainLen ? age + 1 : -1
      }
    }

    if (++this.blockCount >= REPORT_EVERY_BLOCKS) {
      this.blockCount = 0
      this.port.postMessage({
        type: 'pos',
        t: this.pos / this.srcRate,
        rate: this.rate,
        playing: this.playing,
      } satisfies WorkletOutMessage)
    }
    return true
  }
}

registerProcessor('scrub-processor', ScrubProcessor)
