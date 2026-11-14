import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OverlayWindow } from '../../src/main/screen/overlay-window'
import { HighlightController } from '../../src/main/screen/highlight'
import { observeTargetClick } from '../../src/main/screen/target-click'

app.setName('Triage Highlight Check')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'triage-native-highlight-')))
let overlay: OverlayWindow
let controller: HighlightController
let fixture: BrowserWindow
app.on('before-quit', () => { controller?.dispose(); overlay?.dispose() })
app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay()
  fixture = new BrowserWindow({
    title: 'Triage Highlight Check — synthetic fixture', width: 600, height: 430,
    x: display.workArea.x + 120, y: display.workArea.y + 120, frame: false,
    webPreferences: { preload: join(__dirname, '../preload/highlight-check.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  fixture.on('closed', () => app.quit())
  overlay = new OverlayWindow()
  await overlay.initialize()
  controller = new HighlightController({
    display: (id) => overlay.display(id), draw: (state) => overlay.draw(state), hide: () => overlay.hide(),
    observeClick: observeTargetClick
  })
  const native = (overlay as unknown as { window: BrowserWindow }).window
  let markerWasVisible = false
  native.on('show', () => { markerWasVisible = true })
  console.log('Overlay focusable:', native.isFocusable())
  controller.onChange(() => console.log('Marker active:', Boolean(controller.snapshot())))
  ipcMain.on('fixture:action', (event, action: unknown) => {
    if (event.sender !== fixture.webContents) return
    if (action === 'show') {
      controller.clear()
      markerWasVisible = false
      const window = fixture.getContentBounds()
      const bounds = display.bounds
      const capture = {
        id: 'synthetic-native-fixture', capturedAt: Date.now(), displayId: String(display.id), displayName: display.label,
        width: bounds.width, height: bounds.height, bounds, scaleFactor: display.scaleFactor, rotation: display.rotation,
        cursor: { x: 0, y: 0 }
      }
      const plan = controller.plan({
        explanation: 'Synthetic target only; no model or screen image.',
        captureId: capture.id,
        target: { x: (window.x + 120 - bounds.x) / bounds.width, y: (window.y + 205 - bounds.y) / bounds.height,
          width: 240 / bounds.width, height: 56 / bounds.height }
      }, capture, 'fixture-task', controller.revision)!
      controller.present(plan)
    } else if (action === 'clicked') {
      const actual = native.getBounds()
      const aligned = (['x', 'y', 'width', 'height'] as const).every((key) => actual[key] === display.bounds[key])
      const passed = markerWasVisible && aligned && BrowserWindow.getFocusedWindow() === fixture
      console.log('Overlay display bounds:', aligned ? 'PASS' : JSON.stringify({ actual, expected: display.bounds }))
      console.log('Click-through and retained focus:', passed ? 'PASS' : 'NOT OBSERVED')
      setTimeout(() => {
        const dismissed = controller.snapshot() === null && !native.isVisible()
        console.log('Target click dismissal:', dismissed ? 'PASS' : 'NOT OBSERVED')
        fixture.webContents.send('fixture:result', passed && dismissed ? 'PASS: click reached the button, focus stayed here, and the marker cleared.' : 'Repeat with a visible marker; click-through, focus, or dismissal was not observed.')
      }, 500)
    } else if (action === 'dismiss') controller.clear()
  })
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><title>Triage Highlight Check</title><style>
    body { margin:0; background:#fbf6eb; color:#493b32; font:16px -apple-system,sans-serif; padding:24px; }
    h1{font-size:24px} p{font-size:14px;line-height:1.5} button {font:inherit;padding:10px;border-radius:8px;border:1px solid #b58c69;background:white;}
    #target{position:absolute;left:120px;top:205px;width:240px;height:56px;background:#ffddbd} #result{position:absolute;left:24px;top:290px;width:550px}
    </style></head><body><h1>Native highlight check</h1><p>Synthetic fixture. No screenshot capture, credentials, or network requests.</p>
    <button id="show">Show persistent marker</button> <button id="dismiss">Dismiss</button>
    <button id="target">Click through here · 0</button><p id="result">Show the marker, wait at least three seconds, then click the marked button to clear it.</p>
    <script>let count=0;document.querySelector('#show').onclick=()=>window.fixture.action('show');
    document.querySelector('#dismiss').onclick=()=>window.fixture.action('dismiss');
    document.querySelector('#target').onclick=()=>{count++;document.querySelector('#target').textContent='Click through here · '+count;window.fixture.action('clicked')};
    window.fixture.onResult(text=>document.querySelector('#result').textContent=text);</script></body></html>`
  await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  fixture.show()
  fixture.focus()
}).catch((error) => { console.error(error); app.exit(1) })
