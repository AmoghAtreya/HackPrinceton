import { randomUUID } from 'node:crypto'
import type { ElementAnchor, FrameReading, HighlightReply, HighlightSource, HighlightState, Rectangle } from '../../shared/highlight-contracts.ts'
import type { CaptureMetadata } from '../../shared/screen-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { mapFrame, mapRectangle } from './coordinates.ts'

export const TRACK_INTERVAL_MS = 150
export const TRACK_GRACE_MS = 1000
export const HIGHLIGHT_LOST_MESSAGE = 'The button moved off screen. Ask me again.'

export interface DisplayGeometry { bounds: Rectangle; scaleFactor?: number; rotation?: number }
export interface HighlightPort {
  display(id: string): DisplayGeometry | undefined
  draw(state: HighlightState): void
  /** Repaints a highlight that is already visible, without the hide/show of draw(). */
  redraw?(state: HighlightState): void
  blocked?(target: Rectangle): boolean
  observeClick?(target: Rectangle, clicked: () => void): () => void
  hide(): void
  /** Where a snapshotted element is now. Without this, element highlights are drawn but not tracked. */
  frameOf?(pid: number, path: number[]): Promise<FrameReading>
  /** Repeating timer; returns its stop function. Replaceable so tests can drive the loop. */
  every?(milliseconds: number, tick: () => Promise<void>): () => void
  now?(): number
}
/** `anchor` is present when the highlight is locked onto an accessibility element. */
export interface HighlightPlan { state: HighlightState; revision: number; capture: CaptureMetadata; anchor?: ElementAnchor }

export function highlightSource(plan: HighlightPlan): HighlightSource { return plan.anchor ? 'element_id' : 'pixel_box' }

interface Tracking {
  anchor: ElementAnchor
  capture: CaptureMetadata
  stop: () => void
  busy: boolean
  /** When the element was first found missing, or its app first found in the background. */
  lostSince?: number
  /** The rectangle moved and the click observer still points at the old place. */
  rearm: boolean
}

export class HighlightController {
  private port: HighlightPort
  private current: HighlightState | null = null
  private version = 0
  private disposed = false
  private stopObservingClick?: () => void
  private tracking?: Tracking
  private listeners = new Set<() => void>()
  private lostListeners = new Set<(state: HighlightState) => void>()
  private clickListeners = new Set<(state: HighlightState) => void>()
  constructor(port: HighlightPort) { this.port = port }
  get revision(): number { return this.version }
  snapshot(): HighlightState | null {
    return this.current ? { ...this.current, bounds: { ...this.current.bounds }, rectangle: { ...this.current.rectangle } } : null
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Fires after a tracked highlight was cleared because its element or app went away. */
  onLost(listener: (state: HighlightState) => void): () => void { this.lostListeners.add(listener); return () => { this.lostListeners.delete(listener) } }
  /** Fires when the person clicks the highlighted target themselves, just before the highlight clears. Triage only observes the click. */
  onClicked(listener: (state: HighlightState) => void): () => void { this.clickListeners.add(listener); return () => { this.clickListeners.delete(listener) } }
  private emit(): void { for (const listener of this.listeners) listener() }
  private now(): number { return this.port.now?.() ?? Date.now() }
  private tracks(anchor?: ElementAnchor): boolean { return Boolean(anchor && this.port.frameOf) }
  private sameDisplay(capture: CaptureMetadata): boolean {
    const display = this.port.display(capture.displayId)
    return Boolean(display &&
      (['x', 'y', 'width', 'height'] as const).every((key) => display.bounds[key] === capture.bounds[key]) &&
      (capture.scaleFactor === undefined || capture.scaleFactor === display.scaleFactor) &&
      (capture.rotation === undefined || capture.rotation === display.rotation))
  }
  // A tracked highlight re-reads its element's position, so the age of the
  // screenshot no longer matters; the display geometry always does.
  private fresh(capture: CaptureMetadata, tracked = false): boolean {
    const age = Date.now() - capture.capturedAt
    return this.sameDisplay(capture) && (tracked || (age >= 0 && age <= 30000))
  }
  plan(reply: HighlightReply, capture: CaptureMetadata, taskId: string, revision: number, anchor?: ElementAnchor): HighlightPlan | null {
    if (this.disposed || revision !== this.version || reply.captureId !== capture.id || !this.fresh(capture, this.tracks(anchor)))
      throw new AppProblem('stale_highlight', 'No highlight: the screen capture expired or the display changed. Capture again before asking where to click.')
    if (!anchor && !reply.target) return null
    const mapped = anchor ? mapFrame(anchor.frame, capture.bounds) : mapRectangle(reply.target!, capture.bounds)
    if (this.port.blocked?.(mapped.desktop)) throw new AppProblem('highlight_obscured', 'No highlight: Triage is covering that control. Move Triage aside and capture again.')
    return { revision, capture, ...(anchor ? { anchor: { ...anchor, frame: { ...anchor.frame }, path: [...anchor.path] } } : {}),
      state: { id: randomUUID(), taskId, captureId: capture.id,
        displayId: capture.displayId, bounds: { ...capture.bounds }, rectangle: mapped.local, expiresAt: null } }
  }
  /**
   * A highlight for an element that was not located from a screenshot (for
   * example one chosen in the simplified view). There is no image to go stale,
   * so the display's current geometry stands in for the capture.
   */
  planElement(anchor: ElementAnchor, displayId: string, taskId: string): HighlightPlan {
    const display = this.port.display(displayId)
    if (!display) throw new AppProblem('stale_highlight', 'No highlight: that display is no longer connected.')
    const capture: CaptureMetadata = {
      id: randomUUID(), capturedAt: Date.now(), displayId, displayName: '', width: display.bounds.width, height: display.bounds.height,
      bounds: { ...display.bounds }, cursor: { x: 0, y: 0 },
      ...(display.scaleFactor === undefined ? {} : { scaleFactor: display.scaleFactor }),
      ...(display.rotation === undefined ? {} : { rotation: display.rotation })
    }
    return this.plan({ explanation: '', captureId: capture.id, target: null }, capture, taskId, this.version, anchor)!
  }
  present(plan: HighlightPlan): boolean {
    if (this.disposed || this.current || plan.revision !== this.version || !this.fresh(plan.capture, this.tracks(plan.anchor)) || (plan.state.expiresAt !== null && plan.state.expiresAt <= Date.now())) return false
    const target = this.desktopTarget(plan.state)
    if (this.port.blocked?.(target)) return false
    this.current = plan.state
    try { this.port.draw(plan.state) } catch { this.clear(); return false }
    this.observe(plan.state)
    if (plan.anchor && this.tracks(plan.anchor)) this.follow(plan.state.id, plan.anchor, plan.capture)
    this.emit()
    return true
  }
  private desktopTarget(state: HighlightState): Rectangle {
    return { ...state.rectangle, x: state.bounds.x + state.rectangle.x, y: state.bounds.y + state.rectangle.y }
  }
  private observe(state: HighlightState): void {
    this.stopObservingClick?.()
    this.stopObservingClick = this.port.observeClick?.(this.desktopTarget(state), () => {
      if (this.current?.id !== state.id) return
      const clicked = this.current
      for (const listener of this.clickListeners) listener(clicked)
      this.clear()
    })
  }
  private follow(id: string, anchor: ElementAnchor, capture: CaptureMetadata): void {
    const every = this.port.every ?? ((milliseconds: number, tick: () => Promise<void>) => {
      const timer = setInterval(() => { void tick() }, milliseconds)
      timer.unref?.()
      return () => clearInterval(timer)
    })
    const tracking: Tracking = { anchor, capture, busy: false, rearm: false, stop: () => {} }
    this.tracking = tracking
    tracking.stop = every(TRACK_INTERVAL_MS, () => this.track(id, tracking))
  }
  private async track(id: string, tracking: Tracking): Promise<void> {
    if (this.tracking !== tracking || tracking.busy || this.current?.id !== id) return
    tracking.busy = true
    let reading: FrameReading
    try { reading = await this.port.frameOf!(tracking.anchor.pid, tracking.anchor.path) }
    catch { reading = { frame: null, frontmost: true } }
    finally { tracking.busy = false }
    const state = this.current
    if (this.tracking !== tracking || !state || state.id !== id) return
    if (!this.sameDisplay(tracking.capture)) { this.clear(); return }
    let rectangle: Rectangle | undefined
    // A different role at the same path means the page changed under us: that is not our element.
    if (reading.frontmost && reading.frame && reading.role === tracking.anchor.role) {
      try { rectangle = mapFrame(reading.frame, state.bounds).local } catch { /* Scrolled off this display. */ }
    }
    if (!rectangle) {
      const now = this.now()
      tracking.lostSince ??= now
      if (now - tracking.lostSince > TRACK_GRACE_MS) this.lose(state)
      return
    }
    tracking.lostSince = undefined
    const moved = (['x', 'y', 'width', 'height'] as const).some((key) => Math.abs(rectangle[key] - state.rectangle[key]) >= 0.5)
    if (moved) {
      const next = { ...state, rectangle }
      this.current = next
      // Do not start a click observer per scroll frame; re-arm once the element settles.
      this.stopObservingClick?.()
      this.stopObservingClick = undefined
      tracking.rearm = true
      try { (this.port.redraw ?? this.port.draw).call(this.port, next) } catch { this.clear() }
    } else if (tracking.rearm) {
      tracking.rearm = false
      this.observe(state)
    }
  }
  private lose(state: HighlightState): void {
    this.clear()
    for (const listener of this.lostListeners) listener(state)
  }
  clear(): void {
    this.version++
    this.tracking?.stop()
    this.tracking = undefined
    this.stopObservingClick?.()
    this.stopObservingClick = undefined
    const wasVisible = Boolean(this.current)
    this.current = null
    this.port.hide()
    if (wasVisible) this.emit()
  }
  dispose(): void { this.disposed = true; this.clear(); this.listeners.clear(); this.lostListeners.clear(); this.clickListeners.clear() }
}
