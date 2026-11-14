import type { ElementKind, PageRegion } from './simplifier-contracts'
export interface Rectangle { x: number; y: number; width: number; height: number }
export interface LinkWarning {
  rectangle: Rectangle
  label: 'Potential phishing' | 'Unencrypted HTTP'
}

/** elementId is present only when the model chose a listed accessibility element. */
export interface HighlightReply { explanation: string; captureId: string; target: Rectangle | null; elementId?: string }
/** One row of the compact element list offered to the model. No values, only labels. */
export interface LocateElement { id: string; kind: ElementKind; label: string; region: PageRegion }
/** How a highlight was located. Logged in history; carries no screen text. */
export type HighlightSource = 'element_id' | 'pixel_box'
/** What a tracked highlight is anchored to: where the element was, and how to find it again. */
export interface ElementAnchor { frame: Rectangle; pid: number; path: number[]; role: string }
/** A live reading of a tracked element. Geometry and role only. */
export interface FrameReading { frame: Rectangle | null; frontmost: boolean; role?: string }
export interface HighlightState {
  id: string; taskId: string; captureId: string; displayId: string
  bounds: Rectangle; rectangle: Rectangle; expiresAt: number | null
  // Optional presentation geometry, in desktop DIP, owned by the native overlay.
  warnings?: LinkWarning[]
  arrowOrigin?: { x: number; y: number }
  overlayBounds?: Rectangle
}
export interface OverlayBridge {
  getHighlight(): Promise<HighlightState | null>
  onHighlight(listener: (state: HighlightState | null) => void): () => void
  highlightReady(id: string): void
}
export const highlightChannels = {
  get: 'highlight:get', state: 'highlight:state', ready: 'highlight:ready'
} as const
