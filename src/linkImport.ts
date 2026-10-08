/**
 * Fetches a video from a pasted X (Twitter) or YouTube link, entirely in the
 * browser. No server of our own: public APIs that allow cross-origin reads
 * resolve the link to a plain MP4, which is then downloaded into a File.
 *
 * - X: fxtwitter / vxtwitter return the tweet's MP4 variants, and
 *   video.twimg.com allows cross-origin downloads. Highest bitrate wins.
 * - YouTube: the Invidious companion behind Koutube (iv.igerman.cc) proxies
 *   the muxed (video+audio) stream with open CORS, falling back to a public
 *   Piped instance. YouTube only muxes up to 360p. Best effort: YouTube
 *   blocks these proxies from time to time. The title comes from oEmbed.
 */

type Link = { kind: 'x'; id: string; index: number } | { kind: 'youtube'; id: string }

const X_APIS = ['https://api.fxtwitter.com/status/', 'https://api.vxtwitter.com/i/status/']
/** Invidious companions; itag 18 is the 360p MP4 with sound. */
const INVIDIOUS_COMPANIONS = ['https://iv.igerman.cc']
const PIPED_APIS = ['https://api.piped.private.coffee']
const API_TIMEOUT_MS = 12000

export function parseLink(text: string): Link | null {
  let url: URL
  try {
    url = new URL(text.trim().match(/https?:\/\/\S+/)?.[0] ?? text.trim())
  } catch {
    return null
  }
  const host = url.hostname.replace(/^(www|m|mobile|music)\./, '')
  if (/^(x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com$/.test(host)) {
    const m = url.pathname.match(/\/status(?:es)?\/(\d+)(?:\/(?:video|photo)\/(\d+))?/)
    return m ? { kind: 'x', id: m[1], index: m[2] ? Number(m[2]) - 1 : 0 } : null
  }
  if (host === 'youtu.be' || host === 'koutu.be') {
    const id = url.pathname.slice(1).split('/')[0]
    return /^[\w-]{11}$/.test(id) ? { kind: 'youtube', id } : null
  }
  if (host === 'youtube.com' || host === 'koutube.com' || host === 'youtube-nocookie.com') {
    const id =
      url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1] ?? ''
    return /^[\w-]{11}$/.test(id) ? { kind: 'youtube', id } : null
  }
  return null
}

type Source = { url: string; name: string }

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS), referrerPolicy: 'no-referrer' })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

type XVideo = { url?: string; type?: string; formats?: { url: string; bitrate?: number; container?: string }[] }

async function resolveX(id: string, index: number): Promise<Source> {
  let lastErr: unknown
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
      if (url) return { url, name: `@${author}-${id}.mp4` }
      throw new Error('이 트윗에는 영상이 없어요')
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

type PipedStream = { url: string; videoOnly?: boolean; quality?: string; mimeType?: string; height?: number }

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

/** Every route that might serve this YouTube video, best first. */
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

/** Downloads the linked video. `onProgress` gets bytes so far and the total (0 if unknown). */
export async function fetchLinkVideo(
  link: Link,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  if (link.kind === 'x') return download(await resolveX(link.id, link.index), onProgress, signal)
  let lastErr: unknown = new Error('no YouTube source')
  for await (const src of youtubeSources(link.id)) {
    signal?.throwIfAborted()
    try {
      return await download(src, onProgress, signal)
    } catch (err) {
      if (signal?.aborted) throw err
      lastErr = err
    }
  }
  throw lastErr
}

async function download(src: Source, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal) {
  const res = await fetch(src.url, { signal, referrerPolicy: 'no-referrer' })
  if (!res.ok || !res.body) throw new Error(`${res.status} download`)
  const total = Number(res.headers.get('content-length')) || 0
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
  if (got < 1024) throw new Error('empty download')
  const name = src.name.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 120)
  return new File(parts, name, { type: 'video/mp4' })
}
