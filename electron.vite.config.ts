import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: 'src/main/index.ts', 'browser-worker': 'src/worker/browser-worker.ts' } } }
  },
  preload: {
    // The sandboxed preload can only require('electron'), so libraries it uses
    // (zod, via the shared contracts) must be bundled into it.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
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
