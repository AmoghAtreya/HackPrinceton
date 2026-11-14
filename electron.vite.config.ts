import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: 'src/main/index.ts', 'browser-worker': 'src/worker/browser-worker.ts' } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        output: { format: 'cjs', entryFileNames: 'index.js' }
      }
    }
  },
  renderer: {
    plugins: [
      react(),
      {
        name: 'triage-development-csp',
        apply: 'serve',
        transformIndexHtml: {
          order: 'post',
          handler: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        }
      }
    ],
    server: { host: '127.0.0.1' }
  }
})
