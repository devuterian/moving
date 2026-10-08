import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openRecorder } from '../src/recorder.ts'

function setup() {
  const requests = []
  const pageEvents = new Map()
  const elements = new Map(['video', '.recorder-status', '[data-act="rec"]', '[data-act="flip"]'].map((key) => [key, { classList: { toggle() {} } }]))
  const clicks = new Map()
  const dialog = {
    querySelector: (key) => elements.get(key),
    addEventListener: (type, handler) => clicks.set(type, handler),
    remove() {},
  }
  globalThis.document = { createElement: () => dialog }
  globalThis.window = {
    isSecureContext: true,
    addEventListener: (type, handler) => pageEvents.set(type, handler),
    removeEventListener: (type) => pageEvents.delete(type),
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) } },
  })
  const result = openRecorder({ appendChild() {} })
  const close = () => clicks.get('click')({ target: { closest: () => ({ dataset: { act: 'close' } }) } })
  return { requests, pageEvents, elements, result, close }
}

function stream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true } }, { stopped: false, stop() { this.stopped = true } }]
  return { tracks, getTracks: () => tracks }
}

test('late camera permission after close stops every track', async () => {
  const s = setup()
  s.close()
  assert.equal(await s.result, null)
  const media = stream()
  s.requests[0].resolve(media)
  await Promise.resolve()
  assert.ok(media.tracks.every((track) => track.stopped))
  assert.equal(s.elements.get('video').srcObject, null)
})

test('closing before rejection does not request the camera again', async () => {
  const s = setup()
  s.close()
  s.requests[0].reject(new Error('permission denied'))
  await Promise.resolve()
  assert.equal(s.requests.length, 1)
})

test('late video-only fallback after close is stopped too', async () => {
  const s = setup()
  s.requests[0].reject(new Error('microphone unavailable'))
  await Promise.resolve()
  assert.equal(s.requests.length, 2)
  s.close()
  const media = stream()
  s.requests[1].resolve(media)
  await Promise.resolve()
  assert.ok(media.tracks.every((track) => track.stopped))
})

test('page exit stops active camera and removes the exit listener', async () => {
  const s = setup()
  const media = stream()
  s.requests[0].resolve(media)
  await Promise.resolve()
  assert.equal(s.elements.get('video').srcObject, media)
  s.pageEvents.get('pagehide')()
  assert.equal(await s.result, null)
  assert.ok(media.tracks.every((track) => track.stopped))
  assert.equal(s.pageEvents.has('pagehide'), false)
})
