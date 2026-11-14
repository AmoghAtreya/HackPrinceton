export interface CaptureMetadata {
  id: string; capturedAt: number; displayId: string; displayName: string
  width: number; height: number
  scaleFactor?: number; rotation?: number
  bounds: { x: number; y: number; width: number; height: number }
  cursor: { x: number; y: number }
  /**
   * How many private fields (passwords, card numbers, ...) were blacked out of
   * the image before it was encoded. null means the screen could not be checked
   * and the image is unredacted. Only this count is ever saved, never where the fields were.
   */
  redactedRegions: number | null
}

/** The line shown under a screenshot preview; empty when the screen was checked and nothing needed hiding. */
export function redactionNotice(redactedRegions: number | null): string {
  if (redactedRegions === null) return 'Couldn’t check for private fields'
  if (redactedRegions === 0) return ''
  return 'Hid ' + redactedRegions + (redactedRegions === 1 ? ' private field' : ' private fields')
}
export interface ScreenImage { metadata: CaptureMetadata; data: string; mediaType: 'image/jpeg' }
export interface ScreenPreview { metadata: CaptureMetadata; dataUrl: string }
export interface ScreenCaptureOptions { cursor?: { x: number; y: number }; focusAfterCapture?: boolean }
export interface ScreenAccess { take(id: string): ScreenImage; discard?(id: string): void }
