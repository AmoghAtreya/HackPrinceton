import type { ContextElement, ContextSnapshot } from '../../shared/context-contracts.ts'
import type { ScreenCaptureOptions, ScreenPreview } from '../../shared/screen-contracts.ts'
import type { ContextFrame } from '../../shared/context-contracts.ts'
import { privateFrames } from '../screen/redact.ts'
import type { ContextService } from './service.ts'

/** What the assistant needs to turn a model-chosen element id back into a real element. */
export interface ContextLookup {
  /** The accessibility snapshot taken together with this screenshot, if it is still valid. */
  forCapture(captureId: string): ContextSnapshot | undefined
  /** Throws unless the id belongs to that exact snapshot and generation. */
  element(snapshotId: string, generation: number, elementId: string): ContextElement
}
interface Screens {
  capture(options?: ScreenCaptureOptions): Promise<ScreenPreview>
  clear(): void
}

/**
 * Captures a screenshot and an accessibility snapshot as one unit. The capture
 * port calls snapshotContext() at the moment it grabs the image (Triage's own
 * windows are hidden then), with the cursor point it used, so both describe the
 * same screen and the same display. The snapshot is optional: without
 * Accessibility permission the screenshot still works and highlights fall back
 * to pixel boxes.
 */
export class PairedCapture implements ContextLookup {
  private screens: Screens
  private contexts?: ContextService
  private pending?: ContextSnapshot
  private pair?: { captureId: string; contextId: string }
  constructor(screens: Screens, contexts?: ContextService) { this.screens = screens; this.contexts = contexts }

  /** Never rejects: a failed snapshot must not fail the screenshot. */
  async snapshotContext(cursor: { x: number; y: number }): Promise<void> {
    this.pending = undefined
    if (!this.contexts) return
    try { this.pending = await this.contexts.capture({ cursor }) } catch { /* Pixel-box fallback. */ }
  }

  /**
   * Takes the snapshot for this capture and returns the frames to black out of
   * the screenshot, or null if the screen could not be read. Never rejects.
   */
  async privateFields(cursor: { x: number; y: number }): Promise<ContextFrame[] | null> {
    await this.snapshotContext(cursor)
    return privateFrames(this.pending)
  }

  async capture(options?: ScreenCaptureOptions): Promise<ScreenPreview> {
    this.pair = undefined
    this.pending = undefined
    const preview = await this.screens.capture(options)
    // snapshotContext() may have filled this in while the screenshot was being taken.
    const context = this.pending as ContextSnapshot | undefined
    this.pending = undefined
    if (context && context.elements.length && context.displayId === preview.metadata.displayId)
      this.pair = { captureId: preview.metadata.id, contextId: context.id }
    return preview
  }

  forCapture(captureId: string): ContextSnapshot | undefined {
    if (!this.contexts || this.pair?.captureId !== captureId) return undefined
    try { return this.contexts.get(this.pair.contextId) } catch { return undefined }
  }

  element(snapshotId: string, generation: number, elementId: string): ContextElement {
    if (!this.contexts) throw new Error('Context snapshots are unavailable.')
    return this.contexts.element(snapshotId, generation, elementId)
  }

  clear(): void {
    this.pair = undefined
    this.pending = undefined
    this.screens.clear()
    this.contexts?.clear()
  }
}
