export interface CursorSample { x: number; y: number; at: number; displayId: string }

// All distances are macOS device-independent pixels. No pointer trace is persisted.
export class ShakeDetector {
  private samples: CursorSample[] = []
  private nextAllowed = 0

  reset(): void { this.samples = [] }

  feed(sample: CursorSample): boolean {
    if (![sample.x, sample.y, sample.at].every(Number.isFinite)) { this.reset(); return false }
    const last = this.samples.at(-1)
    if (last && (sample.at <= last.at || sample.at - last.at > 150 ||
        sample.displayId !== last.displayId || Math.hypot(sample.x - last.x, sample.y - last.y) > 600)) this.reset()
    if (sample.at < this.nextAllowed) { this.reset(); return false }
    this.samples.push({ ...sample })
    this.samples = this.samples.filter((point) => sample.at - point.at <= 1100).slice(-36)
    if (this.samples.length < 8 || sample.at - this.samples[0].at < 1000) return false
    const xs = this.samples.map((point) => point.x)
    const ys = this.samples.map((point) => point.y)
    const xSpan = Math.max(...xs) - Math.min(...xs)
    const ySpan = Math.max(...ys) - Math.min(...ys)
    if (Math.max(xSpan, ySpan) < 64) return false
    const axis = xSpan >= ySpan ? 'x' : 'y'
    let extreme = this.samples[0][axis]
    let direction = 0
    let reversals = 0
    let travel = 0
    for (let i = 1; i < this.samples.length; i++) {
      const value = this.samples[i][axis]
      travel += Math.abs(value - this.samples[i - 1][axis])
      if (!direction) {
        if (Math.abs(value - extreme) >= 24) { direction = Math.sign(value - extreme); extreme = value }
      } else if ((value - extreme) * direction >= 0) extreme = value
      else if (Math.abs(value - extreme) >= 24) { reversals++; direction *= -1; extreme = value }
    }
    const first = this.samples[0]
    const displacement = Math.hypot(sample.x - first.x, sample.y - first.y)
    if (reversals < 4 || travel < 240 || displacement > Math.min(100, travel * 0.35)) return false
    this.nextAllowed = sample.at + 3000
    this.reset()
    return true
  }
}
