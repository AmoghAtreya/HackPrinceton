// Watches whether Google Chrome is the app the person is looking at, so the
// companion can offer a one-click "Simplify" button above Triage. Only the
// front app's bundle id is read: never a window title, address or page text.

/** Chrome and its release channels. Chrome web apps (com.google.Chrome.app.*) are not tabs, so they do not count. */
const CHROME_BUNDLE_IDS = new Set(['com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.dev', 'com.google.Chrome.canary'])

export function isChrome(bundleId: string): boolean { return CHROME_BUNDLE_IDS.has(bundleId) }

export interface ChromeFrontOptions {
  /** Bundle id of the app in front, or "" when none. */
  read: () => string
  /** Called only when the answer changes. */
  changed: (chromeInFront: boolean) => void
  /** False while checking would be pointless (Triage hidden, capturing, asleep); the answer then reads as false. */
  enabled?: () => boolean
  intervalMs?: number
}

export class ChromeFrontWatcher {
  private options: ChromeFrontOptions
  private timer?: ReturnType<typeof setInterval>
  private current = false

  constructor(options: ChromeFrontOptions) { this.options = options }

  get chromeInFront(): boolean { return this.current }

  start(): void {
    if (this.timer) return
    this.check()
    this.timer = setInterval(() => this.check(), this.options.intervalMs ?? 1000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.set(false)
  }

  check(): void {
    let next = false
    if (this.options.enabled?.() ?? true) {
      try { next = isChrome(this.options.read()) } catch { next = false }
    }
    this.set(next)
  }

  private set(next: boolean): void {
    if (next === this.current) return
    this.current = next
    this.options.changed(next)
  }
}
