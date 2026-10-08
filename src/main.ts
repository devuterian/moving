import './style.css'
import { AudioEngine } from './audioEngine'
import { FrameCache } from './frameCache'
import { clearLastVideo, loadLastVideo, saveLastVideo } from './lastVideo'
import { canRecord, openRecorder } from './recorder'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const app = $('app')
const stage = $('stage')
const video = $<HTMLVideoElement>('video')
const canvas = $<HTMLCanvasElement>('canvas')
const ctx2d = canvas.getContext('2d', { desynchronized: true })!
const fileInput = $<HTMLInputElement>('file')
const timeline = $('timeline')
const autoplayToggle = $<HTMLInputElement>('autoplay')
const freezeToggle = $<HTMLInputElement>('freeze')

/** Sensitivity: seconds of media per screen width of drag (log slider). */
const MIN_SECONDS_PER_SCREEN = 0.5
const MAX_SECONDS_PER_SCREEN = 30
const DEFAULT_SECONDS_PER_SCREEN = MIN_SECONDS_PER_SCREEN * (MAX_SECONDS_PER_SCREEN / MIN_SECONDS_PER_SCREEN) ** 0.85
const TAP_MAX_PX = 8
const TAP_MAX_MS = 250

const engine = new AudioEngine()
let cache: FrameCache | null = null
let objectUrl: string | null = null
let loaded = false
let loadToken = 0

// Gesture state. `target` is where the finger puts the playhead: media time
// moves exactly in proportion to the drag, like dragging a shape.
let target = 0
let scrubbing = false
let showingCanvas = false
let needsSettle = false
/** Mirror mode: the left half is reflected onto the right, about the center. */
let symmetric = false

const SENSITIVITY_KEY = 'scrubber:sensitivity:v2'
let secondsPerScreen = Number(localStorage.getItem(SENSITIVITY_KEY)) || DEFAULT_SECONDS_PER_SCREEN

const AUTOPLAY_KEY = 'scrubber:autoplay'
autoplayToggle.checked = localStorage.getItem(AUTOPLAY_KEY) === '1'
autoplayToggle.addEventListener('change', () =>
  localStorage.setItem(AUTOPLAY_KEY, autoplayToggle.checked ? '1' : '0'),
)

const FREEZE_KEY = 'scrubber:freeze'
freezeToggle.checked = localStorage.getItem(FREEZE_KEY) !== '0'
freezeToggle.addEventListener('change', () =>
  localStorage.setItem(FREEZE_KEY, freezeToggle.checked ? '1' : '0'),
)

if (!canRecord()) document.querySelectorAll('[data-act="record"]').forEach((b) => b.remove())

// ---------------------------------------------------------------------------
// Loading

async function loadFile(file: File, { restored = false, mirrored = false } = {}) {
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|3gp)$/i.test(file.name)) {
    toast('영상 파일만 돼요')
    return
  }
  const token = ++loadToken
  engine.unlock()
  engine.pause()
  setLoading(restored ? '지난 영상 불러오는 중…' : '영상 여는 중…')

  cache?.dispose()
  cache = null
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = URL.createObjectURL(file)
  loaded = false

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('unsupported'))
      video.src = objectUrl!
    })
  } catch {
    if (token !== loadToken) return
    setLoading(null)
    showEmpty()
    if (restored) void clearLastVideo()
    else toast('이 영상은 브라우저가 못 읽어요 😢')
    return
  }
  if (token !== loadToken) return

  setLoading('소리 뽑는 중…')
  const audio = await engine.load(file, video.duration)
  if (!audio || token !== loadToken) return
  const { hasAudio, duration } = audio

  // iOS doesn't paint a paused video until it has played once.
  video.play().then(() => video.pause()).catch(() => {})

  engine.seek(0)
  loaded = true
  setLoading(null)
  app.classList.add('loaded')
  $('filename').textContent = file.name
  app.classList.toggle('mirrored', mirrored)
  $('empty').hidden = true
  $('top').hidden = false
  $('bottom').hidden = false
  $('hint').hidden = false
  if (!hasAudio) toast('소리가 없는 영상이에요')
  if (!restored) void saveLastVideo(file, mirrored)
  void keepAwake()

  cache = new FrameCache(file, objectUrl, duration, video.videoWidth, video.videoHeight)
  const c = cache
  const showProgress = (p: number) => {
    if (c !== cache) return
    $('cached').style.transform = `scaleX(${p})`
    $('prep').hidden = p >= 1
    $('prep').textContent = `프레임 준비 중 ${Math.floor(p * 100)}%`
  }
  c.onProgress = showProgress
  showProgress(0)
  void c.build().then(() => {
    showProgress(c.coverage)
    $('prep').hidden = true
  })
}

// Offline support / installable app (production builds only).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('./sw.js').catch(() => {})
}

// Reopen whatever was loaded last time. Audio still unlocks on the first touch.
void loadLastVideo().then((last) => {
  if (last && !loaded && loadToken === 0) void loadFile(last.file, { restored: true, mirrored: last.mirrored })
})

// Keep the screen on while a video is open. The lock drops whenever the page
// is hidden, so it is taken again on return.
let wakeLock: WakeLockSentinel | null = null
async function keepAwake() {
  if (!loaded || wakeLock || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return
  try {
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', () => (wakeLock = null))
  } catch {
    // Not allowed right now (e.g. battery saver); harmless.
  }
}
document.addEventListener('visibilitychange', () => void keepAwake())

/** Back to the start screen (e.g. after a file failed to open). */
function showEmpty() {
  app.classList.remove('loaded')
  video.removeAttribute('src')
  video.load()
  setCanvasVisible(false)
  $('empty').hidden = false
  $('top').hidden = true
  $('bottom').hidden = true
  $('hint').hidden = true
  $('prep').hidden = true
}

function setLoading(msg: string | null) {
  const el = $('loading')
  el.hidden = !msg
  if (msg) el.querySelector('span')!.textContent = msg
}

let toastTimer = 0
function toast(msg: string) {
  const el = $('toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (el.hidden = true), 2600)
}

// ---------------------------------------------------------------------------
// Opening files: picker (native sheet on mobile), drag & drop, recorder

document.addEventListener('pointerdown', () => engine.unlock(), { capture: true })

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
  const act = el?.dataset.act
  if (el?.getAttribute('role') === 'menuitem') setMenuOpen(false)
  if (act === 'menu') {
    setMenuOpen($('menu').hidden === true)
  } else if (act === 'open') {
    engine.unlock()
    fileInput.click()
  } else if (act === 'record') {
    engine.unlock()
    engine.pause()
    void openRecorder(app).then((rec) => rec && loadFile(rec.file, { mirrored: rec.mirrored }))
  } else if (act === 'play') {
    togglePlay()
  } else if (act === 'settings') {
    setSettingsOpen(true)
  }
})

// ---------------------------------------------------------------------------
// Top-right menu (meatball → dropdown)

const menuItems = () => [...$('menu').querySelectorAll<HTMLElement>('[role="menuitem"]')]

function setMenuOpen(open: boolean, focusFirst = false) {
  $('menu').hidden = !open
  $('menu-btn').setAttribute('aria-expanded', String(open))
  if (open) {
    setSettingsOpen(false)
    if (focusFirst) menuItems()[0]?.focus()
  }
}

$('menu-btn').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    setMenuOpen(true, true)
  }
})

$('menu').addEventListener('keydown', (e) => {
  const items = menuItems()
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next].focus()
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    setMenuOpen(false)
    $('menu-btn').focus()
  }
})

// ---------------------------------------------------------------------------
// Settings

const sensitivity = $<HTMLInputElement>('sensitivity')
const SENS_RANGE = Math.log(MAX_SECONDS_PER_SCREEN / MIN_SECONDS_PER_SCREEN)
const sliderToSeconds = (v: number) => MIN_SECONDS_PER_SCREEN * Math.exp((v / 1000) * SENS_RANGE)
const secondsToSlider = (s: number) => (Math.log(s / MIN_SECONDS_PER_SCREEN) / SENS_RANGE) * 1000

sensitivity.value = String(Math.round(secondsToSlider(secondsPerScreen)))
sensitivity.addEventListener('input', () => {
  secondsPerScreen = sliderToSeconds(Number(sensitivity.value))
  localStorage.setItem(SENSITIVITY_KEY, String(secondsPerScreen))
})

function setSettingsOpen(open: boolean) {
  $('settings').hidden = !open
  if (open) sensitivity.focus()
}

// Tapping anywhere else only closes the menu / settings popover: the tap is
// swallowed so it doesn't also start a scrub or toggle playback.
document.addEventListener(
  'pointerdown',
  (e) => {
    const t = e.target as HTMLElement
    let dismissed = false
    if (!$('menu').hidden && !t.closest('#menu, #menu-btn')) {
      setMenuOpen(false)
      dismissed = true
    }
    if (!$('settings').hidden && !t.closest('#settings, #menu')) {
      setSettingsOpen(false)
      dismissed = true
    }
    if (dismissed && t.closest('#stage, #timeline')) e.stopPropagation()
  },
  { capture: true },
)
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    setMenuOpen(false)
    setSettingsOpen(false)
  }
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  fileInput.value = ''
  if (file) void loadFile(file)
})

let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  dragDepth++
  $('drop').hidden = false
})
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    $('drop').hidden = true
  }
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  $('drop').hidden = true
  const file = e.dataTransfer?.files[0]
  if (file) void loadFile(file)
})

// ---------------------------------------------------------------------------
// Playback

function togglePlay() {
  if (!loaded) return
  if (engine.playing) engine.pause()
  else engine.play()
}

// ---------------------------------------------------------------------------
// Scrubbing: drag anywhere on the stage (relative), or on the timeline
// (absolute). Both make scrub sound.

function beginScrub() {
  scrubbing = true
  app.classList.add('dragging')
  target = engine.time
  engine.scrubTo(target)
  // Freeze: a finger held still keeps sounding instead of going silent.
  engine.hold(freezeToggle.checked)
  $('hint').hidden = true
}

function endScrub(resume: boolean) {
  scrubbing = false
  app.classList.remove('dragging')
  engine.hold(false)
  if (resume) engine.play()
}

function scrubBy(seconds: number) {
  target = Math.min(Math.max(target + seconds, 0), engine.duration)
  engine.scrubTo(target)
}

const pxToSeconds = (px: number) =>
  (px / stage.clientWidth) * secondsPerScreen

let activePointer: number | null = null
let lastX = 0
let downX = 0
let downAt = 0
let wasPlaying = false
/** A second finger joined this drag (so its own tap doesn't toggle playback). */
let multiTouch = false

function toggleSymmetric() {
  symmetric = !symmetric
  // Redraw (or drop the canvas) right away, even while paused at rest.
  needsSettle = true
}

stage.addEventListener('pointerdown', (e) => {
  if (!loaded) return
  if (activePointer !== null) {
    // Another finger while one is already scrubbing: flip mirror mode. The
    // first finger keeps the drag; this one is otherwise ignored.
    if (e.pointerType !== 'mouse') {
      multiTouch = true
      toggleSymmetric()
    }
    return
  }
  if (e.button > 0) return
  multiTouch = false
  activePointer = e.pointerId
  stage.setPointerCapture(e.pointerId)
  wasPlaying = engine.playing
  beginScrub()
  lastX = downX = e.clientX
  downAt = performance.now()
})

const moveEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove'
stage.addEventListener(moveEvent as 'pointermove', (e: PointerEvent) => {
  if (e.pointerId !== activePointer) return
  scrubBy(pxToSeconds(e.clientX - lastX))
  lastX = e.clientX
})

const onPointerEnd = (e: PointerEvent) => {
  if (e.pointerId !== activePointer) return
  activePointer = null
  const isTap =
    Math.abs(e.clientX - downX) < TAP_MAX_PX && performance.now() - downAt < TAP_MAX_MS
  if (isTap) endScrub(multiTouch ? wasPlaying : !wasPlaying)
  else endScrub(autoplayToggle.checked && e.type === 'pointerup')
}
stage.addEventListener('pointerup', onPointerEnd)
stage.addEventListener('pointercancel', onPointerEnd)

// Trackpad / mouse wheel scrubbing on desktop.
let wheelTimer = 0
stage.addEventListener(
  'wheel',
  (e) => {
    if (!loaded) return
    e.preventDefault()
    if (!scrubbing) beginScrub()
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    scrubBy(pxToSeconds(e.deltaMode === 1 ? d * 16 : d))
    clearTimeout(wheelTimer)
    wheelTimer = window.setTimeout(() => endScrub(autoplayToggle.checked), 160)
  },
  { passive: false },
)

let timelinePointer: number | null = null
const timelineTo = (e: PointerEvent) => {
  const r = timeline.getBoundingClientRect()
  target = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * engine.duration
  engine.scrubTo(target)
}
timeline.addEventListener('pointerdown', (e) => {
  if (!loaded) return
  timelinePointer = e.pointerId
  timeline.setPointerCapture(e.pointerId)
  wasPlaying = engine.playing
  beginScrub()
  timelineTo(e)
})
timeline.addEventListener('pointermove', (e) => {
  if (e.pointerId === timelinePointer) timelineTo(e)
})
const endTimeline = (e: PointerEvent) => {
  if (e.pointerId !== timelinePointer) return
  timelinePointer = null
  endScrub(wasPlaying || autoplayToggle.checked)
}
timeline.addEventListener('pointerup', endTimeline)
timeline.addEventListener('pointercancel', endTimeline)

// Shift on its own flips mirror mode. It fires on release, so Shift+Arrow
// (fine stepping) doesn't also flip it.
let shiftAlone = false
window.addEventListener('keydown', (e) => {
  shiftAlone = e.key === 'Shift' && (shiftAlone || !e.repeat)
})
window.addEventListener('keyup', (e) => {
  if (e.key !== 'Shift' || !shiftAlone) return
  shiftAlone = false
  if (loaded && !(e.target instanceof HTMLInputElement)) toggleSymmetric()
})
window.addEventListener('pointerdown', () => (shiftAlone = false), { capture: true })

window.addEventListener('keydown', (e) => {
  if (!loaded || e.target instanceof HTMLInputElement) return
  if (e.code === 'Space') {
    e.preventDefault()
    togglePlay()
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault()
    if (!scrubbing) beginScrub()
    scrubBy((e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.25 : 1))
    endScrub(false)
  }
})

// ---------------------------------------------------------------------------
// Rendering: the audio clock picks the frame

function resizeCanvas() {
  const dpr = Math.min(devicePixelRatio || 1, 2)
  canvas.width = Math.round(stage.clientWidth * dpr)
  canvas.height = Math.round(stage.clientHeight * dpr)
}
new ResizeObserver(resizeCanvas).observe(stage)

function drawFrame(frame: CanvasImageSource, fw: number, fh: number) {
  const cw = canvas.width
  const ch = canvas.height
  const scale = Math.min(cw / fw, ch / fh)
  const w = fw * scale
  const h = fh * scale
  const x = (cw - w) / 2
  const y = (ch - h) / 2
  ctx2d.clearRect(0, 0, cw, ch)
  if (!symmetric) {
    ctx2d.drawImage(frame, x, y, w, h)
    return
  }
  // Left half as is, then the same half flipped onto the right.
  ctx2d.drawImage(frame, 0, 0, fw / 2, fh, x, y, w / 2, h)
  ctx2d.save()
  ctx2d.translate(cw, 0)
  ctx2d.scale(-1, 1)
  ctx2d.drawImage(frame, 0, 0, fw / 2, fh, x, y, w / 2, h)
  ctx2d.restore()
}
const drawBitmap = (frame: ImageBitmap) => drawFrame(frame, frame.width, frame.height)

/**
 * Shows the real <video>. In mirror mode it can't be shown directly, so its
 * current picture is drawn onto the canvas instead.
 */
function showVideo() {
  if (!symmetric) setCanvasVisible(false)
  else if (video.readyState >= 2 && video.videoWidth) {
    drawFrame(video, video.videoWidth, video.videoHeight)
    setCanvasVisible(true)
  }
}

function setCanvasVisible(on: boolean) {
  if (on === showingCanvas) return
  showingCanvas = on
  canvas.classList.toggle('visible', on)
}

const seekVideo = (t: number) => {
  if (!video.seeking && Math.abs(video.currentTime - t) > 1 / 60) video.currentTime = t
}

const fmt = (t: number) => {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

function render() {
  requestAnimationFrame(render)
  if (!loaded) return

  const t = scrubbing ? target : engine.time
  const moving = scrubbing || Math.abs(engine.rate) > 0.02

  if (engine.playing) {
    // Normal forward playback: let the real <video> play, nudged to the audio clock.
    if (video.paused && !(t >= video.duration - 0.05)) {
      video.currentTime = t
      video.play().catch(() => {})
    } else if (Math.abs(video.currentTime - t) > 0.2) {
      seekVideo(t)
    }
    showVideo()
    needsSettle = false
  } else {
    if (!video.paused) video.pause()
    const frame = cache?.get(t)
    if (moving && frame) {
      drawBitmap(frame)
      setCanvasVisible(true)
      needsSettle = true
    } else if (moving && showingCanvas && cache && cache.coverage >= 1) {
      // Every frame exists; this one is still being decoded. Keep the last
      // drawn frame for a moment rather than falling back to slow seeks.
    } else if (moving) {
      // Cache not ready yet: fall back to (choppy) element seeks.
      seekVideo(t)
      showVideo()
    } else if (needsSettle) {
      // Hold the cached frame until the full-quality video catches up.
      if (frame) drawBitmap(frame)
      seekVideo(t)
      if (!video.seeking && Math.abs(video.currentTime - t) <= 1 / 30) {
        needsSettle = false
        showVideo()
      }
    } else {
      seekVideo(t)
      if (symmetric && !video.seeking) showVideo()
    }
  }

  // HUD
  const d = engine.duration || 1
  const p = Math.min(t / d, 1)
  $('played').style.transform = `scaleX(${p})`
  $('handle').style.left = `${p * 100}%`
  $('time').textContent = `${fmt(t)} / ${fmt(engine.duration)}`
  app.classList.toggle('playing', engine.playing)
}
requestAnimationFrame(render)
