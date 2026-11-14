import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { highlightChannels, type HighlightState } from '../../shared/highlight-contracts'
import type { HighlightPort } from './highlight'

export class OverlayWindow implements HighlightPort {
  private window: BrowserWindow
  private warningState: HighlightState | null = null
  private state: HighlightState | null = null
  constructor(private arrowOrigin?: () => { x: number; y: number } | undefined) {
    this.window = new BrowserWindow({
      title: 'Triage Highlight', show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, focusable: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, enableLargerThanScreen: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'), additionalArguments: ['--triage-overlay'],
        // Its own in-memory session: the deny-all permission handler below must not
        // replace the chat window's handler (which allows the microphone for voice input).
        partition: 'triage-overlay',
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, backgroundThrottling: false
      }
    })
    this.window.setIgnoreMouseEvents(true)
    this.window.setAlwaysOnTop(true, 'floating')
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) => event.preventDefault())
    this.window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.window.webContents.on('render-process-gone', () => { this.warningState = null; this.hide() })
    ipcMain.handle(highlightChannels.get, (event) => {
      if (!this.trusted(event)) throw new Error('This window cannot access the overlay.')
      return this.state
    })
    ipcMain.on(highlightChannels.ready, this.ready)
  }
  async initialize(): Promise<void> {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) {
      const url = new URL(devUrl)
      url.searchParams.set('view', 'highlight')
      await this.window.loadURL(url.toString())
    } else await this.window.loadFile(join(__dirname, '../renderer/index.html'), { query: { view: 'highlight' } })
  }
  private trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    if (this.window.isDestroyed() || event.sender !== this.window.webContents || event.senderFrame !== event.sender.mainFrame) return false
    try {
      const url = new URL(event.senderFrame.url)
      const devUrl = process.env.ELECTRON_RENDERER_URL
      if (devUrl) {
        const expected = new URL(devUrl)
        return url.origin === expected.origin && url.pathname === expected.pathname && url.searchParams.get('view') === 'highlight'
      }
      return url.protocol === 'file:' && fileURLToPath(url) === join(__dirname, '../renderer/index.html') && url.searchParams.get('view') === 'highlight'
    } catch { return false }
  }
  display(id: string) {
    const display = screen.getAllDisplays().find((item) => String(item.id) === id)
    return display ? { bounds: { ...display.bounds }, scaleFactor: display.scaleFactor, rotation: display.rotation } : undefined
  }
  draw(state: HighlightState): void {
    if (this.window.isDestroyed()) throw new Error('Overlay window is closed.')
    this.window.hide()
    this.updateGeometry(state)
  }
  private updateGeometry(state: HighlightState): void {
    const origin = state.warnings ? undefined : this.arrowOrigin?.()
    const bounds = state.bounds
    // Include both ends when Triage and the target are on different displays.
    const x = Math.min(bounds.x, origin ? origin.x - 16 : bounds.x)
    const y = Math.min(bounds.y, origin ? origin.y - 16 : bounds.y)
    const overlayBounds = {
      x, y,
      width: Math.max(bounds.x + bounds.width, origin ? origin.x + 16 : bounds.x) - x,
      height: Math.max(bounds.y + bounds.height, origin ? origin.y + 16 : bounds.y) - y
    }
    this.state = { ...state, arrowOrigin: origin, overlayBounds }
    this.window.setBounds(overlayBounds, false)
    this.window.webContents.send(highlightChannels.state, this.state)
  }
  drawWarnings(state: HighlightState | null): void {
    this.warningState = state
    if (this.state && !this.state.warnings) return
    if (state && state.id === this.state?.id) this.updateGeometry(state)
    else if (state) this.draw(state)
    else if (this.state) this.hide()
  }
  refreshArrow(): void {
    if (this.state && !this.state.warnings && !this.window.isDestroyed()) this.updateGeometry(this.state)
  }
  private ready = (event: IpcMainEvent, id: unknown): void => {
    const state = this.state
    if (!this.trusted(event) || !state || id !== state.id || (state.expiresAt !== null && state.expiresAt <= Date.now())) return
    const display = this.display(state.displayId)
    if (!display || !(['x', 'y', 'width', 'height'] as const).every((key) => display.bounds[key] === state.bounds[key])) { this.warningState = null; this.hide(); return }
    // The renderer acknowledges only after painting this exact rectangle.
    this.window.showInactive()
  }
  hide(): void {
    this.state = null
    if (!this.window.isDestroyed()) {
      if (this.warningState?.expiresAt && this.warningState.expiresAt > Date.now()) {
        this.draw(this.warningState)
        return
      }
      this.window.hide()
      this.window.webContents.send(highlightChannels.state, null)
    }
  }
  dispose(): void {
    ipcMain.removeHandler(highlightChannels.get)
    ipcMain.removeListener(highlightChannels.ready, this.ready)
    this.state = null
    if (!this.window.isDestroyed()) this.window.destroy()
  }
}
