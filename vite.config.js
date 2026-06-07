import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false
  },
  server: {
    // GDELT doesn't send CORS headers, so the browser can't call it directly.
    // Proxy /gdelt → api.gdeltproject.org server-side (same-origin to the browser).
    proxy: {
      '/gdelt': {
        target: 'https://api.gdeltproject.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gdelt/, ''),
      },
      '/googlenews': {
        target: 'https://news.google.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/googlenews/, ''),
      },
    },
  },
})
