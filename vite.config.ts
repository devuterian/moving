import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

/**
 * Hosts the /next page may talk to (link import, src/linkImport.ts). Only
 * /next gets them; the main page keeps its strict policy.
 */
const NEXT_CONNECT = [
  'https://rue-cobalt.xenon.zone',
  'https://cobaltapi.cjs.nz',
  'https://api.fxtwitter.com',
  'https://api.vxtwitter.com',
  'https://video.twimg.com',
  'https://www.youtube.com/oembed',
  'https://iv.igerman.cc',
  'https://api.piped.private.coffee',
  'https://proxy.piped.private.coffee',
].join(' ')

const widenCsp = (html: string) =>
  html.replace(/connect-src 'self'/, `connect-src 'self' ${NEXT_CONNECT}`)

/**
 * /next is the same app with experimental features on. GitHub Pages has no
 * rewrites, so the built index.html is copied to next/index.html, with
 * relative URLs pointing one level up, the wider CSP, and noindex.
 */
function nextPage(): Plugin {
  let outDir = 'dist'
  return {
    name: 'next-page',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        // Dev server: /next/ falls back to index.html, so widen it there.
        return ctx.server && ctx.originalUrl?.startsWith('/next') ? widenCsp(html) : html
      },
    },
    closeBundle() {
      const html = readFileSync(resolve(outDir, 'index.html'), 'utf8')
      const next = widenCsp(html)
        .replace(/(href|src)="\.\//g, '$1="../')
        .replace('<title>', '<meta name="robots" content="noindex" />\n    <title>')
      mkdirSync(resolve(outDir, 'next'), { recursive: true })
      writeFileSync(resolve(outDir, 'next/index.html'), next)
    },
  }
}

// `pnpm dev:lan` serves over HTTPS so phones on the same Wi-Fi can use the camera.
export default defineConfig(({ mode }) => ({
  plugins: [nextPage(), ...(mode === 'lan' ? [basicSsl()] : [])],
  // Relative asset URLs: works at a custom domain root and under /<repo>/ alike.
  base: './',
  // Pinned so it never silently lands on (or behind) another project's dev server.
  server: { port: 5199, strictPort: true },
  preview: { port: 5199, strictPort: true },
}))
