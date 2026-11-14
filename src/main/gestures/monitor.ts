import { ShakeDetector, type CursorSample } from './detector.ts'
import type { ShakeTrigger } from '../../shared/shake-contracts.ts'

export interface ShakeMonitorPort {
  enabled(): boolean
  suppressed(): boolean
  sample(): CursorSample
  trigger(value: ShakeTrigger): void
}
export class ShakeMonitor {
  private detector = new ShakeDetector()
  private timer?: ReturnType<typeof setInterval>
  private paused = false
  private disposed = false
  private port: ShakeMonitorPort
  constructor(port: ShakeMonitorPort) { this.port = port }
  start(): void {
    if (!this.timer && !this.disposed) this.timer = setInterval(() => this.poll(), 33)
  }
  poll(): void {
    if (this.disposed || this.paused || !this.port.enabled() || this.port.suppressed()) { this.reset(); return }
    let sample: CursorSample
    try { sample = this.port.sample() } catch { this.reset(); return }
    if (this.detector.feed(sample)) this.port.trigger({
      point: { x: sample.x, y: sample.y }, displayId: sample.displayId, triggeredAt: sample.at
    })
  }
  reset(): void { this.detector.reset() }
  pause(): void { this.paused = true; this.reset() }
  resume(): void { this.reset(); this.paused = false }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.reset()
  }
}
