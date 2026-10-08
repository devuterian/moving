/**
 * Fetches a video from a pasted link, entirely in the browser. No server of
 * our own: public services that allow cross-origin reads resolve the link to
 * a plain video file, which is then downloaded into a File.
 *
 * - Any site: public cobalt instances (github.com/imputnet/cobalt) that don't
 *   require Turnstile. `alwaysProxy` makes them stream the file themselves,
 *   so the download is always cross-origin readable. They can be flaky (a
 *   tunnel sometimes comes back empty), so every route is tried in turn.
 * - X fallback: fxtwitter / vxtwitter list the tweet's MP4s, and
 *   video.twimg.com allows cross-origin downloads. Highest bitrate wins.
 * - YouTube fallback: the Invidious companion behind Koutube (iv.igerman.cc)
 *   and a public Piped instance, both 360p (the best YouTube muxes itself).
 */

type Link =
  | { kind: 'x'; url: string; id: string; index: number }
  | { kind: 'youtube'; url: string; id: string }
  | { kind: 'other'; url: string }

/** Open (no Turnstile) instances, from cobalt.directory. */
const COBALT_APIS = ['https://rue-cobalt.xenon.zone', 'https://cobaltapi.cjs.nz']
const X_APIS = ['https://api.fxtwitter.com/status/', 'https://api.vxtwitter.com/i/status/']
/** Invidious companions; itag 18 is the 360p MP4 with sound. */
const INVIDIOUS_COMPANIONS = ['https://iv.igerman.cc']
const PIPED_APIS = ['https://api.piped.private.coffee']
const API_TIMEOUT_MS = 20000
/** Smaller than this is an error page or an empty tunnel, not a video. */
const MIN_VIDEO_BYTES = 16 * 1024

export function parseLink(text: string): Link | null {
  let url: URL
  try {
    url = new URL(text.trim().match(/https?:\/\/\S+/)?.[0] ?? text.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const href = url.href
  const host = url.hostname.replace(/^(www|m|mobile|music)\./, '')
  if (/^(x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com$/.test(host)) {
    const m = url.pathname.match(/\/status(?:es)?\/(\d+)(?:\/(?:video|photo)\/(\d+))?/)
    if (m) return { kind: 'x', url: href, id: m[1], index: m[2] ? Number(m[2]) - 1 : 0 }
  }
  if (host === 'youtu.be' || host === 'koutu.be') {
    const id = url.pathname.slice(1).split('/')[0]
    if (/^[\w-]{11}$/.test(id)) return { kind: 'youtube', url: `https://youtu.be/${id}`, id }
  }
  if (host === 'youtube.com' || host === 'koutube.com' || host === 'youtube-nocookie.com') {
    const id =
      url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1] ?? ''
    if (/^[\w-]{11}$/.test(id)) return { kind: 'youtube', url: `https://youtu.be/${id}`, id }
  }
  return { kind: 'other', url: href }
}

type Source = { url: string; name: string }

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS), referrerPolicy: 'no-referrer', ...init })
  // cobalt answers errors as JSON with a 4xx status; let the caller read them.
  if (!res.ok && !res.headers.get('content-type')?.includes('json')) throw new Error(`${res.status} ${url}`)
  return res.json()
}

type CobaltResponse = {
  status: 'redirect' | 'tunnel' | 'picker' | 'local-processing' | 'error'
  url?: string
  filename?: string
  picker?: { type: string; url: string }[]
  error?: { code: string }
}

async function* cobaltSources(url: string): AsyncGenerator<Source> {
  for (const api of COBALT_APIS) {
    try {
      const data = (await getJson(api + '/', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, videoQuality: '1080', youtubeVideoCodec: 'h264', alwaysProxy: true }),
      })) as CobaltResponse
      const pick = data.status === 'picker' ? data.picker?.find((p) => p.type === 'video' || p.type === 'gif') : null
      const file = pick?.url ?? (data.status === 'tunnel' || data.status === 'redirect' ? data.url : undefined)
      if (file) yield { url: file, name: data.filename ?? 'video.mp4' }
      else console.info('[link] cobalt', api, data.error?.code ?? data.status)
    } catch (err) {
      console.info('[link] cobalt failed', api, err)
    }
  }
}

type XVideo = { url?: string; formats?: { url: string; bitrate?: number; container?: string }[] }

async function* xSources(id: string, index: number): AsyncGenerator<Source> {
  for (const api of X_APIS) {
    try {
      const data = (await getJson(api + id)) as {
        tweet?: { author?: { screen_name?: string }; media?: { videos?: XVideo[] } }
        user_screen_name?: string
        media_extended?: { type?: string; url?: string }[]
      }
      const author = data.tweet?.author?.screen_name ?? data.user_screen_name ?? 'x'
      let url: string | undefined
      if (data.tweet) {
        const videos = data.tweet.media?.videos ?? []
        const v = videos[index] ?? videos[0]
        const mp4s = (v?.formats ?? []).filter((f) => f.container === 'mp4')
        mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
        url = mp4s[0]?.url ?? v?.url
      } else {
        const videos = (data.media_extended ?? []).filter((m) => m.type === 'video' || m.type === 'gif')
        url = (videos[index] ?? videos[0])?.url
      }
      if (url) yield { url, name: `@${author}-${id}.mp4` }
    } catch (err) {
      console.info('[link] x api failed', api, err)
    }
  }
}

async function youtubeTitle(id: string) {
  try {
    const data = (await getJson(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://youtu.be/${id}`)}`,
    )) as { title?: string }
    return data.title || id
  } catch {
    return id
  }
}

type PipedStream = { url: string; videoOnly?: boolean; quality?: string; mimeType?: string }

async function* youtubeSources(id: string): AsyncGenerator<Source> {
  const name = `${await youtubeTitle(id)}.mp4`
  for (const base of INVIDIOUS_COMPANIONS) {
    yield { url: `${base}/companion/latest_version?id=${id}&itag=18&local=true`, name }
  }
  for (const api of PIPED_APIS) {
    try {
      const data = (await getJson(`${api}/streams/${id}`)) as { videoStreams?: PipedStream[] }
      const muxed = (data.videoStreams ?? []).filter(
        (s) => !s.videoOnly && s.mimeType === 'video/mp4' && /^\d+p/.test(s.quality ?? ''),
      )
      muxed.sort((a, b) => parseInt(b.quality!) - parseInt(a.quality!))
      if (muxed[0]) yield { url: muxed[0].url, name }
    } catch (err) {
      console.info('[link] piped failed', api, err)
    }
  }
}

/** Every route that might serve this link, best first. */
async function* sources(link: Link): AsyncGenerator<Source> {
  // X: fxtwitter is direct and dependable; cobalt is the backup.
  if (link.kind === 'x') yield* xSources(link.id, link.index)
  yield* cobaltSources(link.url)
  if (link.kind === 'youtube') yield* youtubeSources(link.id)
}

/** Downloads the linked video. `onProgress` gets bytes so far and the total (0 if unknown). */
export async function fetchLinkVideo(
  link: Link,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  let lastErr: unknown = new Error('no source')
  for await (const src of sources(link)) {
    signal?.throwIfAborted()
    try {
      return await download(src, onProgress, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      console.info('[link] download failed', src.url, err)
      lastErr = err
    }
  }
  throw lastErr
}

async function download(src: Source, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal) {
  const res = await fetch(src.url, { signal, referrerPolicy: 'no-referrer' })
  if (!res.ok || !res.body) throw new Error(`${res.status} download`)
  const total =
    Number(res.headers.get('content-length')) || Math.max(0, Number(res.headers.get('estimated-content-length')))
  const reader = res.body.getReader()
  const parts: Uint8Array<ArrayBuffer>[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    got += value.byteLength
    onProgress(got, total)
  }
  if (got < MIN_VIDEO_BYTES) throw new Error('empty download')
  const type = res.headers.get('content-type')?.startsWith('video/') ? res.headers.get('content-type')! : 'video/mp4'
  const name = src.name.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 120)
  return new File(parts, /\.\w{2,4}$/.test(name) ? name : `${name}.mp4`, { type })
}
