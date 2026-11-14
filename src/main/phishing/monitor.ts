import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { screen } from 'electron'
import { z } from 'zod'
import type { HighlightState, LinkWarning } from '../../shared/highlight-contracts'

const links = z.array(z.object({
  url: z.string().max(2048),
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().positive().finite(), height: z.number().positive().finite()
})).max(250)

function classify(destination: string): LinkWarning['label'] | undefined {
  const url = URL.parse(destination)
  if (url?.hostname === 'triage-phishing-demo.invalid' && ['http:', 'https:'].includes(url.protocol)) return 'Mock phishing'
  if (url?.protocol === 'http:') return 'Unencrypted HTTP'
}

export class PhishingMonitor {
  private timer?: ReturnType<typeof setInterval>
  private child?: ChildProcess
  private lastScan = ''
  private scanId = ''
  constructor(private helper: string, private suppressed: () => boolean,
    private draw: (state: HighlightState | null) => void, private failed: (permissionDenied: boolean) => void) {}

  start(requestAccess = false): void {
    if (this.timer) return
    this.timer = setInterval(() => this.scan(), 600)
    this.scan(requestAccess)
  }

  clear(): void {
    const child = this.child
    this.child = undefined
    child?.kill()
    this.lastScan = ''
    this.draw(null)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.clear()
  }

  private scan(requestAccess = false): void {
    if (this.suppressed()) { this.clear(); return }
    if (this.child) return
    const child = execFile(this.helper, requestAccess ? ['--request-access'] : [], { timeout: 450, maxBuffer: 800_000 }, (error, stdout) => {
      if (this.child !== child) return
      this.child = undefined
      if (error) {
        this.clear()
        if (!error.killed) {
          this.stop()
          this.failed(error.code === 2)
        }
        return
      }
      if (requestAccess) { this.scan(); return }
      if (this.suppressed()) { this.clear(); return }
      try { this.present(links.parse(JSON.parse(stdout))) } catch { this.clear() }
    })
    this.child = child
  }

  private present(items: z.infer<typeof links>): void {
    const display = screen.getPrimaryDisplay()
    const bounds = display.bounds
    const warnings: LinkWarning[] = []
    for (const { url, ...rectangle } of items) {
      const label = classify(url)
      if (!label || rectangle.x < bounds.x || rectangle.y < bounds.y ||
          rectangle.x + rectangle.width > bounds.x + bounds.width ||
          rectangle.y + rectangle.height > bounds.y + bounds.height) continue
      warnings.push({ label, rectangle: { ...rectangle, x: rectangle.x - bounds.x, y: rectangle.y - bounds.y } })
      if (warnings.length === 12) break
    }
    const key = JSON.stringify([bounds, warnings])
    if (key !== this.lastScan) this.scanId = randomUUID()
    this.lastScan = key
    this.draw(warnings.length ? {
      id: this.scanId, taskId: '', captureId: '', displayId: String(display.id),
      bounds, rectangle: warnings[0].rectangle, warnings, expiresAt: Date.now() + 1200
    } : null)
  }
}
