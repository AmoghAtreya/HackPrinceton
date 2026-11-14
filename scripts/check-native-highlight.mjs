import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin') throw new Error('Run this native fixture on macOS.')
await build({
  entryPoints: [join(root, 'tests/native/highlight-check.ts')], outfile: join(root, 'out/main/highlight-check.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24'
})
await build({
  stdin: { contents: `const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('fixture', {
      action: (value) => ipcRenderer.send('fixture:action', value),
      onResult: (listener) => ipcRenderer.on('fixture:result', (_event, text) => listener(text))
    });`, resolveDir: root },
  outfile: join(root, 'out/preload/highlight-check.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron']
})
const child = spawn(join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  [join(root, 'out/main/highlight-check.cjs')], { cwd: root, stdio: 'inherit' })
child.on('error', (error) => { console.error(error); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
