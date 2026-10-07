import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// `pnpm dev:lan` serves over HTTPS so phones on the same Wi-Fi can use the camera.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'lan' ? [basicSsl()] : [],
  // Pinned so it never silently lands on (or behind) another project's dev server.
  server: { port: 5199, strictPort: true },
  preview: { port: 5199, strictPort: true },
}))
