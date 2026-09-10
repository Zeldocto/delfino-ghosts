import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The site is served from https://<user>.github.io/delfino-ghosts/ in production
// and from / during local development. BASE_PATH can be overridden in CI.
const base = process.env.BASE_PATH ?? '/delfino-ghosts/'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? base : '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
  },
}))
