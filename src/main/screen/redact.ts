import type { ContextFrame, ContextSnapshot } from '../../shared/context-contracts.ts'
import type { Rectangle } from '../../shared/highlight-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { isPrivateLabel } from '../simplifier/classify.ts'

// Screenshots leave this Mac, so password, card and similar fields are blacked
// out first. The rectangles come from the accessibility snapshot taken at the
// same moment as the image; the pixels are overwritten in the raw bitmap, in
// this process, before anything is encoded.

export const REDACTION_PADDING_PX = 4
const FIELD_KINDS = new Set(['input', 'textarea', 'select'])

/**
 * Frames (global screen points) of the fields that must not be visible in a
 * screenshot: every secure text field, plus any field whose label matches the
 * card / CVV / SSN / password patterns the simplifier's risk rules use.
 * Returns null when the snapshot cannot vouch for the screen (nothing was read).
 */
export function privateFrames(snapshot: ContextSnapshot | undefined): ContextFrame[] | null {
  if (!snapshot || !snapshot.elements.length) return null
  return snapshot.elements
    .filter((element) => element.secure || (element.kind !== null && FIELD_KINDS.has(element.kind) && isPrivateLabel(element.label)))
    .map((element) => ({ ...element.frame }))
}

export interface ImageGeometry {
  /** The captured display, in global screen points. */
  bounds: Rectangle
  /** The image, in pixels. It may be larger (Retina) or smaller (downscaled) than the display in points. */
  width: number
  height: number
}

/**
 * Global points -> image pixels, padded by 4 px, grown outward to whole pixels
 * and clipped to the image. Frames that miss the image entirely are dropped.
 */
export function toImageRegions(frames: readonly Rectangle[], geometry: ImageGeometry, padding = REDACTION_PADDING_PX): Rectangle[] {
  const { bounds, width, height } = geometry
  if (![bounds.x, bounds.y, bounds.width, bounds.height, width, height].every(Number.isFinite) ||
      bounds.width <= 0 || bounds.height <= 0 || width < 1 || height < 1) throw new AppProblem('capture_failed', 'Invalid screen image dimensions.')
  const scaleX = width / bounds.width
  const scaleY = height / bounds.height
  const regions: Rectangle[] = []
  for (const frame of frames) {
    if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) continue
    const left = Math.max(0, Math.floor((frame.x - bounds.x) * scaleX - padding))
    const top = Math.max(0, Math.floor((frame.y - bounds.y) * scaleY - padding))
    const right = Math.min(width, Math.ceil((frame.x + frame.width - bounds.x) * scaleX + padding))
    const bottom = Math.min(height, Math.ceil((frame.y + frame.height - bounds.y) * scaleY + padding))
    // Padding alone must not conjure a region for a field that is off this display.
    if ((frame.x + frame.width - bounds.x) * scaleX <= 0 || (frame.y + frame.height - bounds.y) * scaleY <= 0 ||
        (frame.x - bounds.x) * scaleX >= width || (frame.y - bounds.y) * scaleY >= height) continue
    if (right > left && bottom > top) regions.push({ x: left, y: top, width: right - left, height: bottom - top })
  }
  return regions
}

/** Fills each region solid black in a 4-bytes-per-pixel bitmap (colour channels 0, alpha opaque), in place. */
export function blackout(bitmap: Uint8Array, width: number, height: number, regions: readonly Rectangle[]): void {
  if (bitmap.length !== width * height * 4) throw new AppProblem('capture_failed', 'The screen image could not be checked for private fields.')
  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.x))
    const right = Math.min(width, Math.ceil(region.x + region.width))
    const bottom = Math.min(height, Math.ceil(region.y + region.height))
    for (let y = Math.max(0, Math.floor(region.y)); y < bottom; y++) {
      for (let offset = (y * width + left) * 4, end = (y * width + right) * 4; offset < end; offset += 4) {
        bitmap[offset] = 0; bitmap[offset + 1] = 0; bitmap[offset + 2] = 0; bitmap[offset + 3] = 255
      }
    }
  }
}

export interface RedactedImage {
  bytes: Buffer
  /** How many regions were blacked out, or null when the screen could not be checked. */
  redactedRegions: number | null
}

/**
 * The only way a captured bitmap becomes an encoded image. `encode` is handed
 * the bitmap after the private regions were overwritten, never before, so no
 * caller can produce an image that skipped this step. `frames === null` means
 * the check itself failed: the image is still produced, and says so.
 */
export function encodeRedacted(bitmap: Uint8Array, geometry: ImageGeometry, frames: readonly Rectangle[] | null,
  encode: (bitmap: Uint8Array) => Buffer): RedactedImage {
  const regions = frames ? toImageRegions(frames, geometry) : []
  blackout(bitmap, geometry.width, geometry.height, regions)
  return { bytes: encode(bitmap), redactedRegions: frames ? regions.length : null }
}
