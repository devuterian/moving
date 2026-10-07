// Offline support for the installed app. Pages are network-first (so new
// deploys show up right away); hashed build assets are cache-first (their
// names change whenever their content does); everything else is served from
// cache and refreshed in the background.
const CACHE = 'moving-v1'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  const put = (response) => {
    if (response.ok) {
      const copy = response.clone()
      caches.open(CACHE).then((cache) => cache.put(request, copy))
    }
    return response
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(put).catch(() => caches.match(request).then((r) => r || caches.match('./'))))
    return
  }

  if (url.pathname.includes('/assets/')) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then(put)))
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request)
        .then(put)
        .catch(() => cached || Response.error())
      return cached || fresh
    }),
  )
})
