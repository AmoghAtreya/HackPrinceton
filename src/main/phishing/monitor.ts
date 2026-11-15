import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { screen, systemPreferences } from 'electron'
import { z } from 'zod'
import type { HighlightState, LinkWarning } from '../../shared/highlight-contracts'

const links = z.array(z.object({
  url: z.string().max(2048),
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().positive().finite(), height: z.number().positive().finite()
})).max(250)

function classify(destination: string): LinkWarning['label'] | undefined {
  const url = URL.parse(destination)
  if (url?.hostname === 'triage-phishing-demo.invalid' && ['http:', 'https:'].includes(url.protocol)) return 'Potential phishing'
  if (url?.protocol === 'http:') return 'Unencrypted HTTP'
}

/** A phishing link seen again within this window is the same sighting, so it is not announced twice. */
const ANNOUNCE_AGAIN_AFTER_MS = 60000

export class PhishingMonitor {
  private timer?: ReturnType<typeof setInterval>
  private scanning = false
  private revision = 0
  private scanner?: { scanLinks(): Promise<string> | string }
  private lastScan = ''
  private scanId = ''
  /** Phishing URL → when it was last on screen, for links already announced. */
  private announced = new Map<string, number>()
  /**
   * announce: newly visible phishing links (count). Returns false if it could not speak right now
   * (for example while the microphone is on); those links are offered again on the next scan.
   */
  constructor(private helper: string, private suppressed: () => boolean,
    private draw: (state: HighlightState | null) => void, private failed: (permissionDenied: boolean) => void,
    private announce: (count: number) => boolean = () => true) {}

  start(requestAccess = false): void {
    if (this.timer) return
    this.timer = setInterval(() => this.scan(), 600)
    this.scan(requestAccess)
  }

  clear(): void {
    this.revision++
    this.lastScan = ''
    this.draw(null)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.clear()
  }

  private async scan(requestAccess = false): Promise<void> {
    if (this.suppressed()) { this.clear(); return }
    if (this.scanning) return
    if (!systemPreferences.isTrustedAccessibilityClient(requestAccess)) {
      this.stop()
      this.failed(true)
      return
    }

    const revision = this.revision
    this.scanning = true
    try {
      this.scanner ??= createRequire(this.helper)(this.helper)
      const output = await this.scanner!.scanLinks()
      if (revision !== this.revision) return
      if (this.suppressed()) { this.clear(); return }
      this.present(links.parse(JSON.parse(output)))
    } catch {
      if (revision === this.revision) {
        this.stop()
        this.failed(false)
      }
    } finally {
      this.scanning = false
    }
  }

  private present(items: z.infer<typeof links>): void {
    const display = screen.getPrimaryDisplay()
    const bounds = display.bounds
    const warnings: LinkWarning[] = []
    const phishingUrls = new Set<string>()
    for (const { url, ...rectangle } of items) {
      const label = classify(url)
      if (!label || rectangle.x < bounds.x || rectangle.y < bounds.y ||
          rectangle.x + rectangle.width > bounds.x + bounds.width ||
          rectangle.y + rectangle.height > bounds.y + bounds.height) continue
      warnings.push({ label, rectangle: { ...rectangle, x: rectangle.x - bounds.x, y: rectangle.y - bounds.y } })
      if (label === 'Potential phishing') phishingUrls.add(url)
      if (warnings.length === 12) break
    }
    this.announceNew(phishingUrls)
    const key = JSON.stringify([bounds, warnings])
    if (key !== this.lastScan) this.scanId = randomUUID()
    this.lastScan = key
    this.draw(warnings.length ? {
      id: this.scanId, taskId: '', captureId: '', displayId: String(display.id),
      bounds, rectangle: warnings[0].rectangle, warnings, expiresAt: Date.now() + 1200
    } : null)
  }

  /** Speaks up once when phishing links first appear, not on every scan while they stay visible. */
  private announceNew(urls: Set<string>): void {
    const now = Date.now()
    const fresh = [...urls].filter((url) => now - (this.announced.get(url) ?? -Infinity) > ANNOUNCE_AGAIN_AFTER_MS)
    const delivered = fresh.length === 0 || this.announce(fresh.length)
    for (const url of urls) if (delivered || this.announced.has(url)) this.announced.set(url, now)
    for (const [url, seen] of this.announced) if (now - seen > ANNOUNCE_AGAIN_AFTER_MS) this.announced.delete(url)
  }
}
