import workletUrl from './scrub-worklet.ts?worker&url'
import type { WorkletInMessage, WorkletOutMessage } from './scrub-worklet'

type Listener = () => void

/**
 * Owns the AudioContext and the scrub worklet. The worklet's playhead is the
 * master clock: video frames are drawn from whatever time it reports.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private ready: Promise<void> | null = null

  /** Latest playhead state reported by the audio thread. */
  time = 0
  rate = 0
  playing = false
  duration = 0
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
    this.node.connect(ctx.destination)
  }

  /**
   * Decodes the audio track of a media file. Falls back to silence (so the
   * worklet still works as a clock) when there is no decodable audio.
   */
  async load(file: Blob, fallbackDuration: number): Promise<{ hasAudio: boolean; duration: number }> {
    await this.unlock()
    const ctx = this.ctx!
    let buffer: AudioBuffer | null = null
    try {
      buffer = await ctx.decodeAudioData(await file.arrayBuffer())
    } catch (err) {
      console.warn('No decodable audio track, using silence', err)
    }

    let channels: Float32Array[]
    if (buffer && buffer.length > 1) {
      channels = []
      for (let c = 0; c < Math.min(buffer.numberOfChannels, 2); c++) {
        // Copy so the transfer below doesn't detach the AudioBuffer's memory.
        channels.push(buffer.getChannelData(c).slice())
      }
    } else {
      const seconds = Number.isFinite(fallbackDuration) && fallbackDuration > 0 ? fallbackDuration : 1
      channels = [new Float32Array(Math.ceil(seconds * ctx.sampleRate))]
    }

    this.duration = channels[0].length / ctx.sampleRate
    this.time = 0
    this.rate = 0
    this.playing = false
    this.post({ type: 'load', channels }, channels.map((c) => c.buffer as ArrayBuffer))
    return { hasAudio: !!buffer && buffer.length > 1, duration: this.duration }
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
