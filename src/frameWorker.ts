/// <reference lib="webworker" />
/**
 * Decodes every video frame with WebCodecs (via Mediabunny) off the main
 * thread, sequentially and in hardware, far faster than driving a <video>.
 *
 * Preferred output ('encoded'): each downscaled frame is re-encoded as its own
 * key frame (H.264, else VP9/VP8). Any frame can then be decoded on its own in
 * about a millisecond, while taking ~1/80 of the memory of raw pixels, so long
 * clips keep a decent resolution.
 *
 * Fallback output ('raw'): ImageBitmaps, when no usable VideoEncoder exists.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import { planFrames, type FramePlan, type PlanLimits } from './framePlan'

export type FrameMode = 'encoded' | 'raw'

export type FrameWorkerRequest = { file: Blob; encoded: PlanLimits; raw: PlanLimits }

export type FrameWorkerMessage =
  | ({ type: 'plan'; mode: FrameMode } & FramePlan)
  | { type: 'config'; config: VideoDecoderConfig }
  | { type: 'chunk'; index: number; data: ArrayBuffer }
  | { type: 'frame'; index: number; bitmap: ImageBitmap }
  | { type: 'done' }
  | { type: 'unsupported'; reason: string }

/** Bits per pixel for each key frame: enough to stay sharp at small sizes. */
const BITS_PER_PIXEL = 0.4
const MAX_ENCODE_QUEUE = 8

const post = (msg: FrameWorkerMessage, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer)

async function pickEncoder(plan: FramePlan): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null
  const base = {
    width: plan.width,
    height: plan.height,
    framerate: plan.fps,
    bitrate: Math.round(plan.width * plan.height * plan.fps * BITS_PER_PIXEL),
    latencyMode: 'realtime' as const,
  }
  // H.264 Baseline 3.1 first: the one codec every WebCodecs engine (incl.
  // Safari) can both encode and decode.
  for (const codec of ['avc1.42E01F', 'vp09.00.10.08', 'vp8']) {
    const config: VideoEncoderConfig = { ...base, codec, ...(codec.startsWith('avc') && { avc: { format: 'avc' } }) }
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config
    } catch {
      // try the next codec
    }
  }
  return null
}

self.onmessage = async (e: MessageEvent<FrameWorkerRequest>) => {
  const { file } = e.data
  if (typeof VideoDecoder === 'undefined') return post({ type: 'unsupported', reason: 'no WebCodecs' })

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return post({ type: 'unsupported', reason: 'no video track' })
    if (!(await track.canDecode())) return post({ type: 'unsupported', reason: `cannot decode ${track.codec}` })

    const [duration, stats] = await Promise.all([track.computeDuration(), track.computePacketStats(120)])
    const planFor = (limits: PlanLimits) =>
      planFrames(track.displayWidth, track.displayHeight, duration, stats.averagePacketRate, limits)

    let plan = planFor(e.data.encoded)
    const encoderConfig = await pickEncoder(plan)
    const mode: FrameMode = encoderConfig ? 'encoded' : 'raw'
    if (!encoderConfig) plan = planFor(e.data.raw)
    post({ type: 'plan', mode, ...plan })

    let encoder: VideoEncoder | null = null
    let encodeError: unknown = null
    if (encoderConfig) {
      let sentConfig = false
      encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (!sentConfig && meta?.decoderConfig) {
            sentConfig = true
            post({ type: 'config', config: meta.decoderConfig })
          }
          const data = new ArrayBuffer(chunk.byteLength)
          chunk.copyTo(data)
          // The slot index travels as the chunk timestamp.
          post({ type: 'chunk', index: chunk.timestamp, data }, [data])
        },
        error: (err) => (encodeError = err),
      })
      encoder.configure(encoderConfig)
    }

    // CanvasSink applies rotation metadata (portrait phone videos) and resizes.
    const sink = new CanvasSink(track, { width: plan.width, height: plan.height, fit: 'fill' })
    let last = -1
    for await (const { canvas, timestamp } of sink.canvases()) {
      if (encodeError) throw encodeError
      const index = Math.round(timestamp * plan.fps)
      // Several source frames can share a slot when the source fps is higher.
      if (index <= last || index >= plan.slots) continue
      last = index

      if (encoder) {
        while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          await new Promise((r) => encoder!.addEventListener('dequeue', r, { once: true }))
        }
        const frame = new VideoFrame(canvas, { timestamp: index })
        encoder.encode(frame, { keyFrame: true })
        frame.close()
      } else {
        // Read the pixels back and build a CPU-backed bitmap: GPU-backed ones
        // made in a worker can arrive blank on the main thread (seen in Chromium).
        const c2d = (canvas as OffscreenCanvas).getContext('2d')!
        const bitmap = await createImageBitmap(c2d.getImageData(0, 0, plan.width, plan.height))
        post({ type: 'frame', index, bitmap }, [bitmap])
      }
    }
    if (encoder) {
      await encoder.flush()
      encoder.close()
      if (encodeError) throw encodeError
    }
    post({ type: 'done' })
  } catch (err) {
    post({ type: 'unsupported', reason: String(err) })
  } finally {
    input.dispose()
  }
}
