import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/janus': {
        target: 'ws://localhost:8188',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/janus/, '')
      },
      '/ws/control': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws\/control/, '')
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})

