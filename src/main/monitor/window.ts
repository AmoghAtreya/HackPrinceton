import { BrowserWindow, screen } from 'electron'

/**
 * The Learning Monitor as a Triage window. It loads only the local monitor
 * server's page: sandboxed, no preload, no Node, and it can never navigate
 * elsewhere or open other windows.
 */
export class MonitorWindow {
  private window?: BrowserWindow
  private readonly url: () => Promise<string>

  constructor(url: () => Promise<string>) { this.url = url }

  async show(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return }
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(1100, Math.round(area.width * 0.6))
    const window = new BrowserWindow({
      width, height: Math.min(860, area.height), x: area.x + area.width - width, y: area.y,
      title: 'Triage Learning Monitor', show: false, backgroundColor: '#f6f1e8',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
    })
    const target = await this.url()
    const origin = new URL(target).origin
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, next) => { if (new URL(next).origin !== origin) event.preventDefault() })
    window.on('closed', () => { if (this.window === window) this.window = undefined })
    this.window = window
    await window.loadURL(target)
    if (!window.isDestroyed()) window.show()
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = undefined
  }
}
