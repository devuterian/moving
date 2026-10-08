<img src="assets/icon.svg" width="64" height="64" alt="">

# moving

Drop a video, grab the screen and drag left/right: the picture **and the sound** scrub with your finger, backwards included. Works on desktop and mobile, and can record a clip in the browser.

Live at **https://moving.marierie.net** (GitHub Pages, deployed by `.github/workflows/deploy.yml` on every push to `main`).

```sh
pnpm install
pnpm dev        # http://localhost:5199
pnpm dev:lan    # HTTPS on your LAN, so phones can use the camera
pnpm build
```

## How it works

- **Audio** — the file's audio track is decoded to PCM once, and an AudioWorklet (`src/scrub-worklet.ts`) plays it. Dragging only picks a direction: the playhead always moves at normal speed, forward or backward, and stops when the finger stops. Sound is rendered as short overlapping windowed grains, so direction flips are click-free. The worklet's playhead is the master clock.
- **Video** — a worker (`src/frameWorker.ts`) decodes the file with WebCodecs via [Mediabunny](https://mediabunny.dev), downsizes each frame and re-encodes it as an independent key frame (H.264, else VP9/VP8). `src/frameCache.ts` keeps those small chunks and decodes frames around the playhead on demand (prefetching in the drag direction), so every frame is available while scrubbing, at ~1/80 of the memory of raw pixels. Without WebCodecs it falls back to grabbing frames from a hidden `<video>` (play pass, then exact seeks for anything missed). While scrubbing frames come from this cache; at rest or during normal playback the full-quality `<video>` is shown.
- **Analytics** — Cloudflare Web Analytics beacon in `index.html` (no cookies; page views and referrers only).
- **Memory** — the last opened (or recorded) video is kept in IndexedDB (`src/lastVideo.ts`) and reopens automatically next visit. It never leaves the device.
- **Controls** — drag left/right and the video follows the finger 1:1 (sensitivity: ⋯ menu → 설정). Tap to play/pause, drag the timeline to scrub across the whole clip, use a trackpad or wheel, press ←/→ to step 1 s (shift: 0.25 s), and space to play/pause. Two toggles: "손 떼면 재생" continues playback forward when you let go, and "꾹 누르면 늘이기" (freeze) keeps a still, held finger sounding by stretching that moment (both off by default).
