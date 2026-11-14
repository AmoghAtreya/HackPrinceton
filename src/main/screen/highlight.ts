import { randomUUID } from 'node:crypto'
import type { HighlightReply, HighlightState, Rectangle } from '../../shared/highlight-contracts.ts'
import type { CaptureMetadata } from '../../shared/screen-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { mapRectangle } from './coordinates.ts'

export interface DisplayGeometry { bounds: Rectangle; scaleFactor?: number; rotation?: number }
export interface HighlightPort {
  display(id: string): DisplayGeometry | undefined
  draw(state: HighlightState): void
  blocked?(target: Rectangle): boolean
  observeClick?(target: Rectangle, clicked: () => void): () => void
  hide(): void
}
export interface HighlightPlan { state: HighlightState; revision: number; capture: CaptureMetadata }

export class HighlightController {
  private port: HighlightPort
  private current: HighlightState | null = null
  private version = 0
  private disposed = false
  private stopObservingClick?: () => void
  private listeners = new Set<() => void>()
  constructor(port: HighlightPort) { this.port = port }
  get revision(): number { return this.version }
  snapshot(): HighlightState | null {
    return this.current ? { ...this.current, bounds: { ...this.current.bounds }, rectangle: { ...this.current.rectangle } } : null
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { for (const listener of this.listeners) listener() }
  private fresh(capture: CaptureMetadata): boolean {
    const display = this.port.display(capture.displayId)
    const age = Date.now() - capture.capturedAt
    return Boolean(display && age >= 0 && age <= 30000 &&
      (['x', 'y', 'width', 'height'] as const).every((key) => display.bounds[key] === capture.bounds[key]) &&
      (capture.scaleFactor === undefined || capture.scaleFactor === display.scaleFactor) &&
      (capture.rotation === undefined || capture.rotation === display.rotation))
  }
  plan(reply: HighlightReply, capture: CaptureMetadata, taskId: string, revision: number): HighlightPlan | null {
    if (this.disposed || revision !== this.version || reply.captureId !== capture.id || !this.fresh(capture))
      throw new AppProblem('stale_highlight', 'No highlight: the screen capture expired or the display changed. Capture again before asking where to click.')
    if (!reply.target) return null
    const mapped = mapRectangle(reply.target, capture.bounds)
    if (this.port.blocked?.(mapped.desktop)) throw new AppProblem('highlight_obscured', 'No highlight: Triage is covering that control. Move Triage aside and capture again.')
    return { revision, capture, state: { id: randomUUID(), taskId, captureId: capture.id,
      displayId: capture.displayId, bounds: { ...capture.bounds }, rectangle: mapped.local, expiresAt: null } }
  }
  present(plan: HighlightPlan): boolean {
    if (this.disposed || this.current || plan.revision !== this.version || !this.fresh(plan.capture) || (plan.state.expiresAt !== null && plan.state.expiresAt <= Date.now())) return false
    const target = { ...plan.state.rectangle, x: plan.state.bounds.x + plan.state.rectangle.x, y: plan.state.bounds.y + plan.state.rectangle.y }
    if (this.port.blocked?.(target)) return false
    this.current = plan.state
    try { this.port.draw(plan.state) } catch { this.clear(); return false }
    this.stopObservingClick = this.port.observeClick?.(target, () => {
      if (this.current?.id === plan.state.id) this.clear()
    })
    this.emit()
    return true
  }
  clear(): void {
    this.version++
    this.stopObservingClick?.()
    this.stopObservingClick = undefined
    const wasVisible = Boolean(this.current)
    this.current = null
    this.port.hide()
    if (wasVisible) this.emit()
  }
  dispose(): void { this.disposed = true; this.clear(); this.listeners.clear() }
}
