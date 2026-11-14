import { BrowserWindow, screen } from 'electron'
import type { SimplifiedPresenter } from './service.ts'
import { ACTION_PROTOCOL } from './render.ts'

interface Area { x: number; y: number; width: number; height: number }
const overlaps = (a: Area, b: Area) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/**
 * Shows the rendered simplified page in its own Triage window.
 *
 * The HTML is built from untrusted page content (escaped in render.ts), so the
 * window is locked down: sandboxed, no preload, no Node, and JavaScript off
 * (the simplified page needs none). It never navigates; links are handed to
 * `follow`, which opens them in the Chrome "original page" window.
 * `triage-action:` links (presses in a view built from the screen) are handed
 * to `action` the same way and are never loaded.
 */
export class SimplifiedWindow implements SimplifiedPresenter {
  private window?: BrowserWindow
  private readonly follow: (url: string) => void
  private readonly closed: () => void
  private readonly action: (url: string) => void

  /** `closed` lets the simplifier measure how long the page stayed open (a learning signal). */
  constructor(follow: (url: string) => void, closed: () => void = () => {}, action: (url: string) => void = () => {}) {
    this.follow = follow; this.closed = closed; this.action = action
  }

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
        else if (protocol === ACTION_PROTOCOL) this.action(url)
      } catch { /* Ignore malformed links. */ }
    }
    window.webContents.setWindowOpenHandler(({ url }) => { followIfWeb(url); return { action: 'deny' } })
    window.webContents.on('will-navigate', (event, url) => { event.preventDefault(); followIfWeb(url) })
    window.on('closed', () => { if (this.window === window) this.window = undefined; this.closed() })
    this.window = window
    return window
  }

  /** `focus: false` refreshes the page without pulling the person out of the app they are using. */
  show(html: string, title: string, focus = true): void {
    const window = this.ensure()
    window.setTitle('Simplified: ' + title.slice(0, 80))
    void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).then(() => {
      if (window.isDestroyed()) return
      if (focus) { window.show(); window.focus() }
      else if (!window.isVisible()) window.showInactive()
    }).catch(() => {})
  }

  /** Slides the window to whichever side of its display leaves `target` (desktop points) uncovered. */
  avoid(target: Area): void {
    const window = this.window
    if (!window || window.isDestroyed() || !window.isVisible()) return
    const bounds = window.getBounds()
    if (!overlaps(bounds, target)) return
    const area = screen.getDisplayMatching(bounds).workArea
    const candidates = [
      { ...bounds, x: area.x + area.width - bounds.width }, { ...bounds, x: area.x },
      { ...bounds, y: area.y + area.height - bounds.height }, { ...bounds, y: area.y }
    ]
    const clear = candidates.find((candidate) => !overlaps(candidate, target))
    if (clear) window.setBounds(clear)
  }

  /** Closes the simplified page so the original is in view again. */
  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close()
  }

  dispose(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = undefined
  }
}
