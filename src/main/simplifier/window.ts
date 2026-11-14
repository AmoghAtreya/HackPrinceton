import { BrowserWindow } from 'electron'
import type { SimplifiedPresenter } from './service.ts'

/**
 * Shows the rendered simplified page in its own Triage window.
 *
 * The HTML is built from untrusted page content (escaped in render.ts), so the
 * window is locked down: sandboxed, no preload, no Node, and JavaScript off
 * (the simplified page needs none). It never navigates; links are handed to
 * `follow`, which opens them in the Chrome "original page" window.
 */
export class SimplifiedWindow implements SimplifiedPresenter {
  private window?: BrowserWindow
  private readonly follow: (url: string) => void

  constructor(follow: (url: string) => void) { this.follow = follow }

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window
    const window = new BrowserWindow({
      width: 820, height: 900, show: false, title: 'Simplified page', backgroundColor: '#fbf8f2',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false }
    })
    const followIfWeb = (url: string) => {
      try {
        const protocol = new URL(url).protocol
        if (protocol === 'https:' || protocol === 'http:') this.follow(url)
      } catch { /* Ignore malformed links. */ }
    }
    window.webContents.setWindowOpenHandler(({ url }) => { followIfWeb(url); return { action: 'deny' } })
    window.webContents.on('will-navigate', (event, url) => { event.preventDefault(); followIfWeb(url) })
    window.on('closed', () => { if (this.window === window) this.window = undefined })
    this.window = window
    return window
  }

  show(html: string, title: string): void {
    const window = this.ensure()
    window.setTitle('Simplified: ' + title.slice(0, 80))
    void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).then(() => {
      if (!window.isDestroyed()) { window.show(); window.focus() }
    }).catch(() => {})
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = undefined
  }
}
