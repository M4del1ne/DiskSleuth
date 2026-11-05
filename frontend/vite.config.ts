import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Electron loads the production build from file://, so asset paths must be relative
  base: './',
  server: { port: 5199, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
})
