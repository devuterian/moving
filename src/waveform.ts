/**
 * Full-screen waveform for audio files: what's been played is lime, the rest
 * a dim gray. Both colours are pre-rendered once per size into offscreen
 * canvases, so each frame is just two clipped blits.
 */

/** Min/max pairs over this many slices of the track: enough for 4K wide. */
const PEAK_BUCKETS = 8192
const PLAYED = '#c5f82a'
const UNPLAYED = '#4a4b53'

/** Interleaved [min, max] per bucket, from all channels mixed. */
export function computePeaks(channels: Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0
  const buckets = Math.max(1, Math.min(PEAK_BUCKETS, length))
  const peaks = new Float32Array(buckets * 2)
  const k = 1 / channels.length
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * length) / buckets)
    const end = Math.max(start + 1, Math.floor(((b + 1) * length) / buckets))
    let lo = Infinity
    let hi = -Infinity
    for (let i = start; i < end; i++) {
      let v = 0
      for (const ch of channels) v += ch[i]
      v *= k
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    peaks[b * 2] = lo === Infinity ? 0 : lo
    peaks[b * 2 + 1] = hi === -Infinity ? 0 : hi
  }
  return peaks
}

export class Waveform {
  private played = document.createElement('canvas')
  private unplayed = document.createElement('canvas')
  private key = ''

  constructor(private readonly peaks: Float32Array) {}

  /**
   * Draws the whole track into `ctx`, filling the band between `top` and
   * `bottom` (device pixels), coloured up to `progress` (0..1).
   */
  draw(ctx: CanvasRenderingContext2D, progress: number, top: number, bottom: number) {
    const { width, height } = ctx.canvas
    const key = `${width}x${height}:${top}:${bottom}`
    if (key !== this.key) {
      this.key = key
      this.render(this.played, PLAYED, width, height, top, bottom)
      this.render(this.unplayed, UNPLAYED, width, height, top, bottom)
    }
    const x = Math.round(Math.min(Math.max(progress, 0), 1) * width)
    ctx.clearRect(0, 0, width, height)
    if (x > 0) ctx.drawImage(this.played, 0, 0, x, height, 0, 0, x, height)
    if (x < width) ctx.drawImage(this.unplayed, x, 0, width - x, height, x, 0, width - x, height)
  }

  private render(canvas: HTMLCanvasElement, color: string, width: number, height: number, top: number, bottom: number) {
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = color
    const peaks = this.peaks
    const buckets = peaks.length / 2
    // Normalise to the loudest moment so quiet recordings still fill the screen.
    let max = 0
    for (let i = 0; i < peaks.length; i++) max = Math.max(max, Math.abs(peaks[i]))
    const mid = (top + bottom) / 2
    const half = ((bottom - top) / 2) * 0.96
    const scale = max > 0 ? half / max : 0
    const minBar = Math.max(1, Math.round(height / 600))
    for (let x = 0; x < width; x++) {
      const b0 = Math.floor((x * buckets) / width)
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) * buckets) / width))
      let lo = 0
      let hi = 0
      for (let b = b0; b < b1 && b < buckets; b++) {
        lo = Math.min(lo, peaks[b * 2])
        hi = Math.max(hi, peaks[b * 2 + 1])
      }
      const y0 = mid - hi * scale
      const y1 = mid - lo * scale
      const h = Math.max(minBar, y1 - y0)
      ctx.fillRect(x, (y0 + y1) / 2 - h / 2, 1, h)
    }
  }
}
