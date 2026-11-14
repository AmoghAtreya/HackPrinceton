export interface Rectangle { x: number; y: number; width: number; height: number }
export interface HighlightReply { explanation: string; captureId: string; target: Rectangle | null }
export interface HighlightState {
  id: string; taskId: string; captureId: string; displayId: string
  bounds: Rectangle; rectangle: Rectangle; expiresAt: number | null
  // Optional presentation geometry, in desktop DIP, owned by the native overlay.
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
