import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Platform server (Fastify) address; the dev/preview server proxies to it. */
const API_TARGET = 'http://127.0.0.1:8787'

const proxy = {
  '/api': { target: API_TARGET, changeOrigin: true },
  '/internal': { target: API_TARGET, changeOrigin: true },
  '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
})
