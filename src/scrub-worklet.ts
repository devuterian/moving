// Runs on the audio thread. The playhead sticks to a target position set by
// the gesture (moving exactly as far and as fast as the finger, like dragging
// a shape), only smoothed enough to bridge the gaps between pointer events.
// Sound is rendered as short overlapping windowed grains read at the original
// speed in the direction of motion, so the pitch never changes.
//
// The PCM keeps its own sample rate; `step` converts between source samples
// and output samples, so no resampling pass is needed up front.

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

export type WorkletOutMessage =
  | { type: 'pos'; t: number; rate: number; playing: boolean }
  | { type: 'ended' }

// How quickly the playhead catches the finger. Roughly one pointer-event
// interval: enough to turn 60–120 Hz input into continuous motion.
const FOLLOW_SECONDS = 0.008
// Smooths changes of speed (also the ramp in/out of normal playback).
const RATE_SMOOTH_SECONDS = 0.003
const GAIN_SMOOTH_SECONDS = 0.006
// Below this |rate| the output fades out, so a held finger is silent.
const SILENT_RATE = 0.06
// Grain length; grains overlap by half so their Hann windows sum to 1.
const GRAIN_SECONDS = 0.04
const REPORT_EVERY_BLOCKS = 2

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
  private blockCount = 0

  private readonly grainLen = Math.round(GRAIN_SECONDS * sampleRate) & ~1
  private readonly hop = this.grainLen / 2
  private readonly window = Float32Array.from({ length: this.grainLen }, (_, n) =>
    0.5 - 0.5 * Math.cos((2 * Math.PI * n) / this.grainLen),
  )
  // Two overlapping grain slots: source start, direction (±1), age in samples.
  private readonly grainStart = new Float64Array(2)
  private readonly grainDir = new Int8Array(2)
  private readonly grainAge = new Int32Array([-1, -1])
  private nextGrain = 0
  private sinceSpawn = 0

  private readonly followAlpha = 1 - Math.exp(-1 / (FOLLOW_SECONDS * sampleRate))
  private readonly rateAlpha = 1 - Math.exp(-1 / (RATE_SMOOTH_SECONDS * sampleRate))
  private readonly gainAlpha = 1 - Math.exp(-1 / (GAIN_SMOOTH_SECONDS * sampleRate))

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<WorkletInMessage>) => this.handle(e.data)
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
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]
    const frames = out[0].length
    const src = this.channels
    const last = this.length - 1

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
      const gainTarget = speed >= SILENT_RATE ? 1 : speed / SILENT_RATE
      this.gain += (gainTarget - this.gain) * this.gainAlpha

      if (this.sinceSpawn-- <= 0) {
        this.sinceSpawn = this.hop - 1
        const g = this.nextGrain
        this.nextGrain = g ^ 1
        this.grainStart[g] = pos
        this.grainDir[g] = this.rate < 0 ? -1 : 1
        this.grainAge[g] = 0
      }

      for (let c = 0; c < out.length; c++) out[c][i] = 0
      for (let g = 0; g < 2; g++) {
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
