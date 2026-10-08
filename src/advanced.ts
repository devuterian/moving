/**
 * Settings → Advanced: the scrub engine's tunables and the frame cache's
 * resolution cap, saved on this device. Built from a table so adding a knob
 * is one line.
 */
import type { AudioEngine } from './audioEngine'
import { setFrameMaxEdge } from './frameCache'
import { DEFAULT_SCRUB_PARAMS, type ScrubParams } from './scrubParams'

const STORAGE_KEY = 'scrubber:advanced'

type Saved = { params: ScrubParams; frameEdge: number }

type Slider = {
  key: 'grainMs' | 'followMs' | 'smoothMs' | 'silentRate' | 'jitterMs'
  label: string
  hint: string
  min: number
  max: number
  step: number
  format: (v: number) => string
}

const ms = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}ms`

const SLIDERS: Slider[] = [
  { key: 'grainMs', label: '청크 길이', hint: '짧으면 거칠고 또렷, 길면 부드럽고 뭉개져요', min: 10, max: 150, step: 1, format: ms },
  { key: 'followMs', label: '따라붙기', hint: '손가락을 얼마나 바로 따라갈지', min: 1, max: 100, step: 1, format: ms },
  { key: 'smoothMs', label: '속도 부드럽게', hint: '빨라지고 느려질 때 얼마나 매끄럽게', min: 0.5, max: 50, step: 0.5, format: ms },
  { key: 'silentRate', label: '멈춤 문턱', hint: '이보다 느리면 소리가 잦아들어요', min: 0.01, max: 0.3, step: 0.01, format: (v) => `${v.toFixed(2)}×` },
  { key: 'jitterMs', label: '늘이기 흔들림', hint: '꾹 누를 때 청크가 퍼지는 폭', min: 0, max: 100, step: 1, format: ms },
]

/** One-tap starting points. Each sets every sound knob; frame size is left alone. */
const PRESETS: { name: string; emoji: string; params: ScrubParams }[] = [
  { name: '기본', emoji: '🐇', params: DEFAULT_SCRUB_PARAMS },
  {
    name: '턴테이블',
    emoji: '🎧',
    params: { grainMs: 40, overlap: 2, followMs: 3, smoothMs: 1, silentRate: 0.02, jitterMs: 25, tape: true },
  },
  {
    name: '늘어진 카세트',
    emoji: '📼',
    params: { grainMs: 40, overlap: 2, followMs: 70, smoothMs: 40, silentRate: 0.02, jitterMs: 25, tape: true },
  },
  {
    name: '또박또박',
    emoji: '✂️',
    params: { grainMs: 18, overlap: 2, followMs: 2, smoothMs: 0.5, silentRate: 0.1, jitterMs: 8, tape: false },
  },
  {
    name: '로봇 목소리',
    emoji: '🤖',
    params: { grainMs: 10, overlap: 2, followMs: 8, smoothMs: 3, silentRate: 0.03, jitterMs: 0, tape: false },
  },
  {
    name: '꿀 떨어지는',
    emoji: '🍯',
    params: { grainMs: 110, overlap: 4, followMs: 45, smoothMs: 25, silentRate: 0.04, jitterMs: 30, tape: false },
  },
  {
    name: '꿈결',
    emoji: '☁️',
    params: { grainMs: 150, overlap: 4, followMs: 30, smoothMs: 15, silentRate: 0.06, jitterMs: 100, tape: false },
  },
]

const sameParams = (a: ScrubParams, b: ScrubParams) =>
  (Object.keys(a) as (keyof ScrubParams)[]).every((k) => a[k] === b[k])

/** Long-edge caps for the scrub frames; 0 = automatic (by device). */
const FRAME_EDGES: [number, string][] = [
  [0, '자동'],
  [360, '360p'],
  [480, '480p'],
  [720, '720p'],
  [1080, '1080p'],
]

function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Saved> | null
    return {
      params: { ...DEFAULT_SCRUB_PARAMS, ...saved?.params },
      frameEdge: saved?.frameEdge ?? 0,
    }
  } catch {
    return { params: { ...DEFAULT_SCRUB_PARAMS }, frameEdge: 0 }
  }
}

export function initAdvanced(root: HTMLElement, engine: AudioEngine) {
  let state = load()

  root.innerHTML = `
    <div class="adv-presets" role="radiogroup" aria-label="프리셋">
      ${PRESETS.map(
        (p, i) =>
          `<button type="button" class="chip" role="radio" data-preset="${i}"><span aria-hidden="true">${p.emoji}</span>${p.name}</button>`,
      ).join('')}
    </div>
    ${SLIDERS.map(
      (s) => `
      <label class="adv-row" title="${s.hint}">
        <span class="adv-head"><span>${s.label}</span><output data-out="${s.key}"></output></span>
        <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
        <span class="adv-hint">${s.hint}</span>
      </label>`,
    ).join('')}
    <label class="toggle adv-toggle">
      <span><span class="adv-title">청크 촘촘하게</span><span class="adv-hint">4겹으로 겹쳐서 더 부드럽게</span></span>
      <input type="checkbox" data-flag="overlap" />
      <span class="switch"></span>
    </label>
    <label class="toggle adv-toggle">
      <span><span class="adv-title">테이프 모드</span><span class="adv-hint">LP 긁듯이, 속도 따라 음정이 변해요</span></span>
      <input type="checkbox" data-flag="tape" />
      <span class="switch"></span>
    </label>
    <label class="adv-row">
      <span class="adv-head"><span>프레임 해상도</span></span>
      <select data-key="frameEdge">
        ${FRAME_EDGES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
      <span class="adv-hint">끌 때 쓰는 프레임 화질 · 다음에 여는 영상부터 적용</span>
    </label>
    <button type="button" class="secondary adv-reset" data-adv="reset">기본값으로</button>`

  const apply = () => {
    engine.setParams(state.params)
    setFrameMaxEdge(state.frameEdge || null)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }

  const sync = () => {
    for (const s of SLIDERS) {
      root.querySelector<HTMLInputElement>(`[data-key="${s.key}"]`)!.value = String(state.params[s.key])
      root.querySelector(`[data-out="${s.key}"]`)!.textContent = s.format(state.params[s.key])
    }
    root.querySelector<HTMLInputElement>('[data-flag="overlap"]')!.checked = state.params.overlap >= 4
    root.querySelector<HTMLInputElement>('[data-flag="tape"]')!.checked = state.params.tape
    root.querySelector<HTMLSelectElement>('[data-key="frameEdge"]')!.value = String(state.frameEdge)
    root.querySelectorAll<HTMLElement>('[data-preset]').forEach((el) => {
      el.setAttribute('aria-checked', String(sameParams(PRESETS[Number(el.dataset.preset)].params, state.params)))
    })
  }

  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement
    const key = el.dataset.key
    const slider = SLIDERS.find((s) => s.key === key)
    if (slider) state.params = { ...state.params, [slider.key]: Number(el.value) }
    else if (key === 'frameEdge') state.frameEdge = Number(el.value)
    else if (el.dataset.flag === 'overlap') state.params = { ...state.params, overlap: el.checked ? 4 : 2 }
    else if (el.dataset.flag === 'tape') state.params = { ...state.params, tape: el.checked }
    else return
    sync()
    apply()
  })
  root.addEventListener('click', (e) => {
    const preset = (e.target as HTMLElement).closest<HTMLElement>('[data-preset]')
    if (preset) {
      state = { ...state, params: { ...PRESETS[Number(preset.dataset.preset)].params } }
      sync()
      apply()
    } else if ((e.target as HTMLElement).closest('[data-adv="reset"]')) {
      state = { params: { ...DEFAULT_SCRUB_PARAMS }, frameEdge: 0 }
      sync()
      apply()
    }
  })

  sync()
  apply()
}
