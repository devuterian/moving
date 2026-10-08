/** Scrub engine tunables, shared by the UI and the audio worklet. */

/** Tunables exposed in Settings → Advanced. */
export type ScrubParams = {
  /** Grain length in ms. Short = grittier, long = smoother but smeared. */
  grainMs: number
  /** Grains overlapping at once (2 or 4). More = denser, softer sound. */
  overlap: number
  /** How quickly the playhead catches the finger, in ms. */
  followMs: number
  /** Smoothing of speed changes, in ms. */
  smoothMs: number
  /** Below this speed (× normal) the sound fades out. */
  silentRate: number
  /** How far frozen grains wander from the playhead, in ms. */
  jitterMs: number
  /** Pitch follows speed (record scratching) instead of staying fixed. */
  tape: boolean
}

export const DEFAULT_SCRUB_PARAMS: ScrubParams = {
  grainMs: 40,
  overlap: 2,
  followMs: 8,
  smoothMs: 3,
  silentRate: 0.06,
  jitterMs: 25,
  tape: false,
}
