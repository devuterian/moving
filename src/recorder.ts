/**
 * In-app camera recording. Resolves with the recorded clip, or null if closed.
 * `mirrored` is set for front-camera clips so playback can match the mirrored
 * preview the user saw while recording.
 */
export type Recording = { file: File; mirrored: boolean }

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

export const canRecord = () =>
  !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

export function openRecorder(root: HTMLElement): Promise<Recording | null> {
  return new Promise((resolve) => {
    const el = document.createElement('div')
    el.className = 'recorder'
    el.innerHTML = `
      <video class="recorder-preview" playsinline muted autoplay></video>
      <div class="recorder-status" aria-live="polite">카메라 준비 중…</div>
      <div class="recorder-bar">
        <button class="ghost" data-act="close" aria-label="닫기">닫기</button>
        <button class="rec-btn" data-act="rec" aria-label="녹화" disabled><span></span></button>
        <button class="ghost" data-act="flip" aria-label="카메라 전환">전환</button>
      </div>`
    root.appendChild(el)

    const preview = el.querySelector<HTMLVideoElement>('video')!
    const status = el.querySelector<HTMLElement>('.recorder-status')!
    const recBtn = el.querySelector<HTMLButtonElement>('[data-act="rec"]')!
    const flipBtn = el.querySelector<HTMLButtonElement>('[data-act="flip"]')!

    let stream: MediaStream | null = null
    let recorder: MediaRecorder | null = null
    let facing: 'user' | 'environment' = 'user'
    let startedAt = 0
    let timer = 0
    let closed = false
    let startSeq = 0

    const stopStream = () => stream?.getTracks().forEach((t) => t.stop())

    const close = (result: Recording | null) => {
      if (closed) return
      closed = true
      startSeq++
      window.removeEventListener('pagehide', onPageHide)
      clearInterval(timer)
      if (recorder?.state === 'recording') {
        recorder.onstop = null
        recorder.stop()
      }
      stopStream()
      preview.srcObject = null
      el.remove()
      resolve(result)
    }

    const onPageHide = () => close(null)
    window.addEventListener('pagehide', onPageHide)

    const start = async () => {
      const seq = ++startSeq
      stopStream()
      recBtn.disabled = true
      flipBtn.disabled = true
      const video = { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }
      let withMic = true
      let acquired: MediaStream
      try {
        acquired = await navigator.mediaDevices.getUserMedia({ video, audio: true })
      } catch {
        if (closed || seq !== startSeq) return
        // No mic (or mic permission denied): still let them record picture only.
        withMic = false
        try {
          acquired = await navigator.mediaDevices.getUserMedia({ video })
        } catch (err) {
          if (closed || seq !== startSeq) return
          status.textContent = window.isSecureContext ? '카메라 권한이 필요해요' : '녹화는 HTTPS에서만 돼요'
          console.warn(err)
          flipBtn.disabled = false
          return
        }
      }
      if (closed || seq !== startSeq) {
        acquired.getTracks().forEach((t) => t.stop())
        return
      }
      stream = acquired
      preview.srcObject = stream
      preview.classList.toggle('mirrored', facing === 'user')
      status.textContent = withMic ? '버튼을 눌러 녹화' : '마이크 없이 녹화돼요'
      recBtn.disabled = false
      flipBtn.disabled = false
    }

    const record = () => {
      if (!stream) return
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const chunks: Blob[] = []
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      recorder.onstop = () => {
        const type = recorder!.mimeType || mimeType || 'video/webm'
        const ext = type.includes('mp4') ? 'mp4' : 'webm'
        close({
          file: new File(chunks, `녹화-${new Date().toLocaleTimeString('ko-KR')}.${ext}`, { type }),
          mirrored: facing === 'user',
        })
      }
      recorder.start(250)
      startedAt = performance.now()
      el.classList.add('recording')
      flipBtn.disabled = true
      timer = window.setInterval(() => {
        const s = Math.floor((performance.now() - startedAt) / 1000)
        status.textContent = `● ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      }, 200)
      status.textContent = '● 0:00'
    }

    el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'close') close(null)
      else if (act === 'flip') {
        facing = facing === 'user' ? 'environment' : 'user'
        void start()
      } else if (act === 'rec') {
        if (recorder?.state === 'recording') {
          status.textContent = '정리 중…'
          recBtn.disabled = true
          recorder.stop()
        } else record()
      }
    })

    void start()
  })
}
