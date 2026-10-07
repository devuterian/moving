/** Shared sizing for the frame cache (used on the main thread and in the worker). */

export type FramePlan = { fps: number; width: number; height: number; slots: number }

export type PlanLimits = {
  budgetBytes: number
  /** Estimated storage per pixel per frame (4 for raw RGBA, far less when encoded). */
  bytesPerPixel: number
  /** Long-edge size limits. Resolution is sacrificed before frame rate. */
  maxEdge: number
  minEdge: number
  maxFps: number
  minFps: number
}

export function planFrames(
  displayWidth: number,
  displayHeight: number,
  duration: number,
  sourceFps: number,
  limits: PlanLimits,
): FramePlan {
  const vw = displayWidth || 16
  const vh = displayHeight || 9
  let edge = Math.min(limits.maxEdge, Math.max(vw, vh))
  let fps = Math.round(Math.min(limits.maxFps, Math.max(limits.minFps, sourceFps || 30)))
  const size = () => {
    const s = edge / Math.max(vw, vh)
    return [Math.max(2, Math.round(vw * s) & ~1), Math.max(2, Math.round(vh * s) & ~1)] as const
  }
  const bytes = () => {
    const [w, h] = size()
    return w * h * limits.bytesPerPixel * fps * duration
  }
  while (bytes() > limits.budgetBytes && edge > limits.minEdge) edge = Math.round(edge * 0.9)
  while (bytes() > limits.budgetBytes && fps > limits.minFps) fps -= 2
  const [width, height] = size()
  return { fps, width, height, slots: Math.max(1, Math.ceil(duration * fps)) }
}
