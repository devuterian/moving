/**
 * Streams the audio track out of a media file with WebCodecs (via Mediabunny)
 * instead of loading the whole file into memory for decodeAudioData. Each
 * decoded buffer is written at its own timestamp, so audio that starts late
 * (or has gaps) stays in sync with the video.
 */

export type DecodedAudio = { channels: Float32Array[]; sampleRate: number }

/** Long tracks are stored mono to halve memory; stereo barely matters here. */
const STEREO_MAX_SECONDS = 5 * 60

/**
 * Resolves null when the file has no audio track. Throws when the track
 * exists but can't be decoded this way (the caller can try another route).
 */
export async function streamAudio(file: Blob, minSeconds: number): Promise<DecodedAudio | null> {
  const { ALL_FORMATS, AudioBufferSink, BlobSource, Input } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) return null
    if (!(await track.canDecode())) throw new Error(`cannot decode ${track.codec}`)

    const sampleRate = track.sampleRate
    const duration = Math.max(await track.computeDuration(), minSeconds || 0)
    const total = Math.ceil(duration * sampleRate) + 1
    const outChannels = Math.min(track.numberOfChannels, duration > STEREO_MAX_SECONDS ? 1 : 2)
    const channels = Array.from({ length: outChannels }, () => new Float32Array(total))

    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      let at = Math.round(timestamp * sampleRate)
      let skip = 0
      if (at < 0) {
        skip = -at
        at = 0
      }
      const n = Math.min(buffer.length - skip, total - at)
      if (n <= 0) continue
      if (outChannels === 1 && buffer.numberOfChannels > 1) {
        // Downmix to mono.
        const out = channels[0]
        const k = 1 / buffer.numberOfChannels
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const src = buffer.getChannelData(c)
          for (let i = 0; i < n; i++) out[at + i] += src[skip + i] * k
        }
      } else {
        for (let c = 0; c < outChannels; c++) {
          const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))
          channels[c].set(src.subarray(skip, skip + n), at)
        }
      }
    }
    return { channels, sampleRate }
  } finally {
    input.dispose()
  }
}
