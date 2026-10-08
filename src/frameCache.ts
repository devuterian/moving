/**
 * Pre-extracts low-res frames so scrubbing can draw any time instantly, in
 * either direction, without waiting on <video> seeks. Every frame slot gets
 * filled: completeness matters more than resolution or load time.
 *
 * Fast path: a worker decodes the file with WebCodecs (src/frameWorker.ts),
 * sequentially and in hardware, many times faster than real time, and
 * re-encodes every frame as an independent key frame. Those small chunks are
 * kept here and decoded on demand around the playhead (EncodedFrames), so
 * memory stays low and long clips keep their resolution. Without a usable
 * VideoEncoder the worker sends raw bitmaps instead.
 *
 * Fallback (no WebCodecs, or a codec WebCodecs can't decode but <video> can):
 * 1. Play pass: a hidden muted copy plays at ~normal speed and each presented
 *    frame is grabbed (fast; usually covers almost everything).
 * 2. Seek pass: any slot still empty is fetched by seeking to it exactly.
 *    This also covers browsers that refuse to play hidden video (iOS Low
 *    Power Mode) or lack requestVideoFrameCallback.
 */
import { planFrames, type FramePlan, type PlanLimits } from './framePlan'
import type { FrameWorkerMessage, FrameWorkerRequest } from './frameWorker'

const isMobile = matchMedia('(pointer: coarse)').matches
const MB = 1024 * 1024
/** Raw RGBA bitmaps: every pixel costs 4 bytes, so resolution drops fast. */
const BASE_RAW_LIMITS: PlanLimits = {
  budgetBytes: (isMobile ? 160 : 480) * MB,
  bytesPerPixel: 4,
  maxEdge: isMobile ? 480 : 854,
  minEdge: 160,
  maxFps: isMobile ? 30 : 60,
  minFps: 12,
}
/** Key-frame chunks: ~0.05 bytes per pixel at the worker's bitrate. */
const BASE_ENCODED_LIMITS: PlanLimits = {
  budgetBytes: (isMobile ? 120 : 300) * MB,
  bytesPerPixel: 0.07,
  maxEdge: isMobile ? 640 : 854,
  minEdge: 160,
  maxFps: isMobile ? 30 : 60,
  minFps: 12,
}
/** Settings → Advanced can raise or lower the long-edge cap (next file on). */
let maxEdgeOverride: number | null = null
export function setFrameMaxEdge(edge: number | null) {
  maxEdgeOverride = edge
}
const withEdge = (l: PlanLimits): PlanLimits => (maxEdgeOverride ? { ...l, maxEdge: maxEdgeOverride } : l)
const rawLimits = () => withEdge(BASE_RAW_LIMITS)
const encodedLimits = () => withEdge(BASE_ENCODED_LIMITS)

/** Decoded frames kept around the playhead in encoded mode. */
const DECODED_CACHE_BYTES = (isMobile ? 48 : 128) * MB
const PREFETCH_AHEAD = 16
const PREFETCH_BEHIND = 4
const PLAY_RATE = isMobile ? 1 : 2
// Stop the play pass if nothing new arrives for this long (playback blocked).
const STALL_MS = 2500
// WebKit (Safari, and every iOS browser) can hand drawImage the previous
// frame right after 'seeked', so there we wait for the new frame to be
// presented (at most PRESENT_TIMEOUT_MS). Chromium/Gecko draw the right frame
// immediately, which makes the seek pass about twice as fast.
const ua = navigator.userAgent
const WAIT_FOR_PRESENT = /AppleWebKit/.test(ua) && !/Chrome\/|Chromium|Edg\//.test(ua)
const PRESENT_TIMEOUT_MS = 80
const SEEK_TIMEOUT_MS = 3000

// Not in every engine yet (Firefox < 132, Safari < 15.4), so feature-detect.
const hasRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Independent key-frame chunks for every slot, decoded on demand. Frames near
 * the playhead (biased toward the drag direction) are decoded ahead of time
 * into a small LRU of bitmaps, so scrubbing never waits on the decoder.
 */
class EncodedFrames {
  private readonly chunks: (ArrayBuffer | undefined)[]
  private count = 0
  private config: VideoDecoderConfig | null = null
  private decoder: VideoDecoder | null = null
  private readonly decoded = new Map<number, ImageBitmap>()
  private readonly inflight = new Set<number>()
  private readonly maxDecoded: number
  private flushQueued = false
  private lastIndex = 0
  private dir = 1
  private disposed = false

  constructor(
    slots: number,
    frameBytes: number,
  ) {
    this.chunks = new Array(slots)
    this.maxDecoded = Math.max(PREFETCH_AHEAD + PREFETCH_BEHIND + 8, Math.floor(DECODED_CACHE_BYTES / frameBytes))
  }

  get slots() {
    return this.chunks.length
  }

  get coverage() {
    return this.count / this.chunks.length
  }

  configure(config: VideoDecoderConfig) {
    this.config = { ...config, optimizeForLatency: true }
  }

  add(i: number, data: ArrayBuffer) {
    if (i < 0 || i >= this.chunks.length) return
    if (!this.chunks[i]) this.count++
    this.chunks[i] = data
  }

  /** Variable-frame-rate sources can leave a few slots empty: reuse neighbours. */
  fillGaps() {
    const n = this.chunks.length
    let prev: ArrayBuffer | undefined
    for (let i = 0; i < n; i++) prev = this.chunks[i] ??= prev
    let next: ArrayBuffer | undefined
    for (let i = n - 1; i >= 0; i--) next = this.chunks[i] ??= next
    this.count = this.chunks.filter(Boolean).length
  }

  get(i: number): ImageBitmap | undefined {
    if (i !== this.lastIndex) this.dir = i > this.lastIndex ? 1 : -1
    this.lastIndex = i
    this.want(i)
    for (let d = 1; d <= PREFETCH_AHEAD; d++) this.want(i + d * this.dir)
    for (let d = 1; d <= PREFETCH_BEHIND; d++) this.want(i - d * this.dir)

    const hit = this.decoded.get(i)
    if (hit) {
      // Refresh LRU position.
      this.decoded.delete(i)
      this.decoded.set(i, hit)
      return hit
    }
    for (let d = 1; d < 8; d++) {
      const near = this.decoded.get(i - d * this.dir) ?? this.decoded.get(i + d * this.dir)
      if (near) return near
    }
    return undefined
  }

  dispose() {
    this.disposed = true
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    for (const b of this.decoded.values()) b.close()
    this.decoded.clear()
  }

  private ensureDecoder() {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder
    if (!this.config || this.disposed) return null
    const decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (err) => {
        console.warn('[frames] decoder error, will recreate', err)
        this.inflight.clear()
        if (this.decoder === decoder) this.decoder = null
      },
    })
    decoder.configure(this.config)
    this.decoder = decoder
    return decoder
  }

  private want(i: number) {
    if (i < 0 || i >= this.chunks.length) return
    if (this.decoded.has(i) || this.inflight.has(i)) return
    const data = this.chunks[i]
    if (!data) return
    const decoder = this.ensureDecoder()
    if (!decoder) return
    this.inflight.add(i)
    decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data }))
    // Decoders may hold the last frames back until more input arrives; a
    // flush right after each burst of requests pushes them out promptly.
    if (!this.flushQueued) {
      this.flushQueued = true
      queueMicrotask(() => {
        this.flushQueued = false
        if (decoder.state === 'configured') decoder.flush().catch(() => {})
      })
    }
  }

  private onFrame(frame: VideoFrame) {
    const i = frame.timestamp
    createImageBitmap(frame)
      .then((bmp) => {
        this.inflight.delete(i)
        if (this.disposed) return bmp.close()
        this.decoded.get(i)?.close()
        this.decoded.set(i, bmp)
        while (this.decoded.size > this.maxDecoded) {
          const [oldest, b] = this.decoded.entries().next().value!
          this.decoded.delete(oldest)
          b.close()
        }
      })
      .catch(() => this.inflight.delete(i))
      .finally(() => frame.close())
  }
}

export class FrameCache {
  fps = 30
  width = 2
  height = 2
  private frames: (ImageBitmap | undefined)[] = []
  private filled = 0
  private encoded: EncodedFrames | null = null
  private cancelled = false
  private worker: Worker | null = null
  private readonly work = document.createElement('canvas')
  private readonly workCtx = this.work.getContext('2d')!
  onProgress: ((coverage: number) => void) | null = null

  constructor(
    private readonly file: Blob,
    private readonly url: string,
    private readonly duration: number,
    private readonly videoWidth: number,
    private readonly videoHeight: number,
  ) {
    // Provisional plan from the <video> element; the worker replaces it with
    // one based on the real frame rate before any frame arrives.
    this.setRawPlan(planFrames(videoWidth, videoHeight, duration, 30, rawLimits()))
  }

  get coverage() {
    if (this.encoded) return this.encoded.coverage
    return this.frames.length ? this.filled / this.frames.length : 0
  }

  /** Frame for time `t`, or the nearest available one while still filling. */
  get(t: number): ImageBitmap | undefined {
    const n = this.encoded ? this.encoded.slots : this.frames.length
    const i = Math.min(n - 1, Math.max(0, Math.round(t * this.fps)))
    if (this.encoded) return this.encoded.get(i)
    for (let d = 0; d < 8; d++) {
      const a = this.frames[i - d] ?? this.frames[i + d]
      if (a) return a
    }
    return undefined
  }

  async build() {
    const started = performance.now()
    const viaWorker = await this.buildWithWorker()
    if (!viaWorker && !this.cancelled) await this.buildWithVideo()
    const mode = this.encoded ? 'WebCodecs (encoded)' : viaWorker ? 'WebCodecs (raw)' : '<video>'
    console.info(
      `[frames] ${mode}: ${this.encoded?.slots ?? this.frames.length} frames ` +
        `${this.width}x${this.height}@${this.fps} in ${Math.round(performance.now() - started)}ms`,
    )
  }

  dispose() {
    this.cancelled = true
    this.worker?.terminate()
    this.encoded?.dispose()
    for (const f of new Set(this.frames)) f?.close()
    this.frames = []
  }

  private setSize(plan: FramePlan) {
    this.fps = plan.fps
    this.width = this.work.width = plan.width
    this.height = this.work.height = plan.height
  }

  private setRawPlan(plan: FramePlan) {
    this.encoded?.dispose()
    this.encoded = null
    for (const f of new Set(this.frames)) f?.close()
    this.setSize(plan)
    this.frames = new Array(plan.slots)
    this.filled = 0
  }

  private setEncodedPlan(plan: FramePlan) {
    this.setRawPlan({ ...plan, slots: 0 })
    this.setSize(plan)
    this.encoded = new EncodedFrames(plan.slots, plan.width * plan.height * 4)
  }

  private store(i: number, bmp: ImageBitmap) {
    if (this.cancelled || i < 0 || i >= this.frames.length || this.frames[i]) return bmp.close()
    this.frames[i] = bmp
    this.filled++
    this.onProgress?.(this.coverage)
  }

  /** Resolves true when every slot was filled by the WebCodecs worker. */
  private buildWithWorker() {
    return new Promise<boolean>((resolve) => {
      let worker: Worker
      try {
        worker = new Worker(new URL('./frameWorker.ts', import.meta.url), { type: 'module' })
      } catch {
        return resolve(false)
      }
      this.worker = worker
      const finish = (ok: boolean) => {
        worker.terminate()
        if (this.worker === worker) this.worker = null
        resolve(ok)
      }
      worker.onerror = () => finish(false)
      worker.onmessage = (e: MessageEvent<FrameWorkerMessage>) => {
        const msg = e.data
        switch (msg.type) {
          case 'plan':
            if (msg.mode === 'encoded') this.setEncodedPlan(msg)
            else this.setRawPlan(msg)
            break
          case 'config':
            this.encoded?.configure(msg.config)
            break
          case 'chunk':
            this.encoded?.add(msg.index, msg.data)
            this.onProgress?.(this.coverage)
            break
          case 'frame':
            this.store(msg.index, msg.bitmap)
            break
          case 'unsupported':
            console.info('[frames] WebCodecs unavailable:', msg.reason)
            // Start over with the <video> fallback.
            this.setRawPlan(planFrames(this.videoWidth, this.videoHeight, this.duration, 30, rawLimits()))
            finish(false)
            break
          case 'done':
            this.fillGaps()
            finish(true)
            break
        }
      }
      worker.postMessage({ file: this.file, encoded: encodedLimits(), raw: rawLimits() } satisfies FrameWorkerRequest)
    })
  }

  /** Variable-frame-rate sources can leave a few slots empty: reuse neighbours. */
  private fillGaps() {
    if (this.encoded) {
      this.encoded.fillGaps()
    } else {
      const n = this.frames.length
      let prev: ImageBitmap | undefined
      for (let i = 0; i < n; i++) prev = this.frames[i] ??= prev
      let next: ImageBitmap | undefined
      for (let i = n - 1; i >= 0; i--) next = this.frames[i] ??= next
      this.filled = this.frames.filter(Boolean).length
    }
    this.onProgress?.(this.coverage)
  }

  private async buildWithVideo() {
    const video = this.createVideo()
    try {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true })
        video.addEventListener('error', () => reject(video.error), { once: true })
      })
      if (hasRvfc) await this.playPass(video)
      await this.seekPass(video)
    } catch (err) {
      console.warn('Frame cache stopped early', err)
    } finally {
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.remove()
    }
  }

  private createVideo() {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    // Real size, behind everything: iOS may skip decoding tiny or detached videos.
    Object.assign(video.style, {
      position: 'fixed', left: '0', top: '0',
      width: `${this.width}px`, height: `${this.height}px`,
      opacity: '0', pointerEvents: 'none', zIndex: '-1',
    })
    video.src = this.url
    document.body.appendChild(video)
    return video
  }

  /** Copies the video's current frame into slot `i`. */
  private grab(video: HTMLVideoElement, i: number) {
    if (this.cancelled || i < 0 || i >= this.frames.length || this.frames[i]) return
    this.workCtx.drawImage(video, 0, 0, this.width, this.height)
    // createImageBitmap snapshots the canvas synchronously, so the work
    // canvas can be reused right away.
    return createImageBitmap(this.work).then((bmp) => this.store(i, bmp))
  }

  private playPass(video: HTMLVideoElement) {
    return new Promise<void>((resolve) => {
      let lastNew = performance.now()
      let done = false
      const pending: Promise<void>[] = []
      const finish = () => {
        if (done) return
        done = true
        clearInterval(watchdog)
        video.pause()
        void Promise.allSettled(pending).then(() => resolve())
      }
      const onFrame: VideoFrameRequestCallback = (_now, meta) => {
        if (done) return
        if (this.cancelled) return finish()
        const p = this.grab(video, Math.round(meta.mediaTime * this.fps))
        if (p) pending.push(p.then(() => void (lastNew = performance.now())))
        video.requestVideoFrameCallback(onFrame)
      }
      const watchdog = setInterval(() => {
        if (this.cancelled || performance.now() - lastNew > STALL_MS) finish()
      }, 250)
      video.addEventListener('ended', finish, { once: true })
      video.requestVideoFrameCallback(onFrame)
      video.playbackRate = PLAY_RATE
      video.play().catch(finish)
    })
  }

  private async seekPass(video: HTMLVideoElement) {
    for (let i = 0; i < this.frames.length; i++) {
      if (this.cancelled) return
      if (this.frames[i]) continue
      // Land just inside slot i so the frame that starts there is shown.
      const t = Math.min(i / this.fps + 0.001, Math.max(0, this.duration - 0.001))
      await this.seekTo(video, t)
      await this.grab(video, i)
    }
  }

  private seekTo(video: HTMLVideoElement, t: number) {
    return new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
      }
      const timeout = setTimeout(done, SEEK_TIMEOUT_MS)
      video.addEventListener(
        'seeked',
        () => {
          if (WAIT_FOR_PRESENT && hasRvfc) {
            video.requestVideoFrameCallback(() => done())
            void wait(PRESENT_TIMEOUT_MS).then(done)
          } else {
            done()
          }
        },
        { once: true },
      )
      video.currentTime = t
    })
  }
}
