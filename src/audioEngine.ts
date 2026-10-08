import workletUrl from './scrub-worklet.ts?worker&url'
import type { WorkletInMessage, WorkletOutMessage } from './scrub-worklet'
import { streamAudio, type DecodedAudio } from './audioDecode'
import { computePeaks } from './waveform'

const isMobile = matchMedia('(pointer: coarse)').matches
/** decodeAudioData needs the whole file in memory; past this, go silent instead. */
const MAX_WHOLE_DECODE_BYTES = (isMobile ? 300 : 1024) * 1024 * 1024

type Listener = () => void

/** Normalisation target: a gated RMS of about -16 dBFS (roughly -16 LUFS). */
const TARGET_RMS = 10 ** (-16 / 20)
/** Never boost more than this (+20 dB), so near-silence doesn't turn into hiss. */
const MAX_BOOST = 10
/** Peaks stay just under full scale after the gain. */
const PEAK_CEILING = 0.98

/**
 * Gain that brings the track to TARGET_RMS. Loudness is the mean power of
 * 400 ms blocks louder than -50 dBFS, so long silences don't count.
 */
function normalizeGain(channels: Float32Array[], sampleRate: number) {
  const block = Math.max(1, Math.round(sampleRate * 0.4))
  const length = channels[0]?.length ?? 0
  const gate = 10 ** (-50 / 10)
  let peak = 0
  let power = 0
  let blocks = 0
  for (let start = 0; start < length; start += block) {
    const end = Math.min(length, start + block)
    let sum = 0
    for (const ch of channels) {
      for (let i = start; i < end; i++) {
        const v = ch[i]
        sum += v * v
        if (v > peak) peak = v
        else if (-v > peak) peak = -v
      }
    }
    const mean = sum / ((end - start) * channels.length)
    if (mean > gate) {
      power += mean
      blocks++
    }
  }
  if (!blocks || !peak) return 1
  const rms = Math.sqrt(power / blocks)
  return Math.min(TARGET_RMS / rms, MAX_BOOST, PEAK_CEILING / peak)
}

/**
 * Owns the AudioContext and the scrub worklet. The worklet's playhead is the
 * master clock: video frames are drawn from whatever time it reports.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private output: GainNode | null = null
  /** Gain that would normalise the loaded track; applied while `normalize` is on. */
  private trackGain = 1
  private normalizeOn = true
  private ready: Promise<void> | null = null
  private loadSeq = 0

  /** Latest playhead state reported by the audio thread. */
  time = 0
  rate = 0
  playing = false
  duration = 0
  /** Waveform peaks of the loaded track, when load() was asked for them. */
  peaks: Float32Array | null = null
  onEnded: Listener | null = null

  /** Must be called from inside a user gesture at least once (iOS). */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.ready = this.init(this.ctx)
    }
    if (this.ctx.state !== 'running') void this.ctx.resume()
    // iOS keeps Web Audio on the ringer channel unless told otherwise, which
    // means silent mode mutes everything.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    if (session) session.type = 'playback'
    return this.ready!
  }

  private async init(ctx: AudioContext) {
    await ctx.audioWorklet.addModule(workletUrl)
    this.node = new AudioWorkletNode(ctx, 'scrub-processor', {
      numberOfInputs: 0,
      outputChannelCount: [2],
    })
    this.node.port.onmessage = (e: MessageEvent<WorkletOutMessage>) => {
      const msg = e.data
      if (msg.type === 'pos') {
        this.time = msg.t
        this.rate = msg.rate
        this.playing = msg.playing
      } else if (msg.type === 'ended') {
        this.playing = false
        this.onEnded?.()
      }
    }
    this.output = new GainNode(ctx, { gain: this.normalizeOn ? this.trackGain : 1 })
    this.node.connect(this.output).connect(ctx.destination)
  }

  /**
   * Decodes the audio track of a media file. Prefers streaming it out with
   * WebCodecs (low memory, timestamp-accurate); falls back to decodeAudioData
   * for small files, and to silence (so the worklet still works as a clock)
   * when there is no decodable audio. Pads with silence up to the video's
   * length. Resolves null if a newer load() started meanwhile. With
   * `withPeaks`, also computes waveform peaks (before the PCM moves to the
   * audio thread).
   */
  async load(
    file: Blob,
    videoDuration: number,
    { withPeaks = false } = {},
  ): Promise<{ hasAudio: boolean; duration: number } | null> {
    const seq = ++this.loadSeq
    await this.unlock()
    const ctx = this.ctx!
    const minSeconds = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : 0

    let audio: DecodedAudio | null = null
    let hasAudio = false
    try {
      audio = await streamAudio(file, minSeconds)
      hasAudio = !!audio
    } catch (err) {
      console.info('[audio] streaming decode unavailable, trying decodeAudioData:', err)
      audio = await this.decodeWhole(file, minSeconds)
      hasAudio = !!audio
    }
    // A slower, older load must not overwrite the newer file's audio.
    if (seq !== this.loadSeq) return null

    audio ??= {
      channels: [new Float32Array(Math.ceil(Math.max(minSeconds, 1) * ctx.sampleRate))],
      sampleRate: ctx.sampleRate,
    }
    const { channels, sampleRate } = audio
    this.peaks = withPeaks && hasAudio ? computePeaks(channels) : null
    this.trackGain = hasAudio ? normalizeGain(channels, sampleRate) : 1
    this.applyGain()
    this.duration = channels[0].length / sampleRate
    this.time = 0
    this.rate = 0
    this.playing = false
    this.post({ type: 'load', channels, sampleRate }, channels.map((c) => c.buffer as ArrayBuffer))
    return { hasAudio, duration: this.duration }
  }

  /** Whole-file decode: needs the file in memory, so only for modest sizes. */
  private async decodeWhole(file: Blob, minSeconds: number): Promise<DecodedAudio | null> {
    if (file.size > MAX_WHOLE_DECODE_BYTES) return null
    const ctx = this.ctx!
    try {
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
      if (buffer.length < 2) return null
      const length = Math.max(buffer.length, Math.ceil(minSeconds * buffer.sampleRate))
      const channels = Array.from({ length: Math.min(buffer.numberOfChannels, 2) }, (_, c) => {
        const ch = new Float32Array(length)
        ch.set(buffer.getChannelData(c))
        return ch
      })
      return { channels, sampleRate: buffer.sampleRate }
    } catch (err) {
      console.warn('No decodable audio track, using silence', err)
      return null
    }
  }

  /** Scrub: the playhead follows `t` as closely as the finger moves. */
  scrubTo(t: number) {
    this.playing = false
    this.post({ type: 'target', t: this.clamp(t) })
  }

  /** Jump silently to a time. */
  seek(t: number) {
    this.time = this.clamp(t)
    this.post({ type: 'seek', t: this.time })
  }

  /** Loudness normalisation on or off (smoothly, so it never clicks). */
  setNormalize(on: boolean) {
    this.normalizeOn = on
    this.applyGain()
  }

  private applyGain() {
    if (!this.output || !this.ctx) return
    const gain = this.normalizeOn ? this.trackGain : 1
    this.output.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.03)
  }

  /** Freeze: while on, a still playhead keeps sounding (stretched). */
  hold(on: boolean) {
    this.post({ type: 'hold', on })
  }

  play() {
    if (this.time >= this.duration - 0.01) this.time = 0
    this.playing = true
    this.post({ type: 'play' })
  }

  pause() {
    this.playing = false
    this.post({ type: 'pause' })
  }

  private clamp(t: number) {
    return Math.min(Math.max(t, 0), this.duration)
  }

  private post(msg: WorkletInMessage, transfer: Transferable[] = []) {
    this.node?.port.postMessage(msg, transfer)
  }
}
