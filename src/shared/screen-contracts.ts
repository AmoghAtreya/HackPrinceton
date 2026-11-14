export interface CaptureMetadata {
  id: string; capturedAt: number; displayId: string; displayName: string
  width: number; height: number
  scaleFactor?: number; rotation?: number
  bounds: { x: number; y: number; width: number; height: number }
  cursor: { x: number; y: number }
}
export interface ScreenImage { metadata: CaptureMetadata; data: string; mediaType: 'image/jpeg' }
export interface ScreenPreview { metadata: CaptureMetadata; dataUrl: string }
export interface ScreenCaptureOptions { cursor?: { x: number; y: number }; focusAfterCapture?: boolean }
export interface ScreenAccess { take(id: string): ScreenImage; discard?(id: string): void }
