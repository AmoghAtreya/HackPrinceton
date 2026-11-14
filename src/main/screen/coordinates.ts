import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { CaptureMetadata } from '../../shared/screen-contracts.ts'
import type { HighlightReply, Rectangle } from '../../shared/highlight-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'

export const rectangleSchema = z.object({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().gt(0).max(1), height: z.number().finite().gt(0).max(1)
}).strict().refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1)

const pixelBox = z.object({
  x1: z.number().finite().min(0), y1: z.number().finite().min(0),
  x2: z.number().finite().gt(0), y2: z.number().finite().gt(0)
}).strict()
const outputSchema = z.object({
  explanation: z.string().trim().min(1).max(4000).describe('A concise explanation of the visible target, or a clarification when no target is identifiable.'),
  target: pixelBox.nullable().describe('The visible control bounds in absolute image pixels, or null when ambiguous. x1/y1 are top-left; x2/y2 are bottom-right.')
}).strict()

// The SDK removes unsupported wire-schema constraints; strict numeric/image-bound
// validation below remains authoritative after the API returns structured JSON.
export const highlightResponseFormat = zodOutputFormat(outputSchema)

export function parseHighlightReply(text: string, capture: CaptureMetadata): HighlightReply {
  let failure = 'invalid response format'
  try {
    if (text.length > 12000 || !Number.isFinite(capture.width) || !Number.isFinite(capture.height) ||
        capture.width < 1 || capture.height < 1) throw Error()
    // Accept a single presentation wrapper without extracting or guessing data.
    // Any extra prose, alternate fields, or invalid coordinates still fail closed.
    const trimmed = text.trim()
    const wrapped = /^\x60\x60\x60(?:json)?\s*\n([\s\S]*?)\n\x60\x60\x60$/i.exec(trimmed)
    failure = 'invalid JSON format'
    const decoded: unknown = JSON.parse(wrapped ? wrapped[1] : trimmed)
    failure = 'unexpected response fields'
    const result = outputSchema.parse(decoded)
    const box = result.target
    if (!box) return { explanation: result.explanation, captureId: capture.id, target: null }
    failure = 'coordinates outside the captured image or an empty target'
    if (box.x2 <= box.x1 || box.y2 <= box.y1 || box.x2 > capture.width || box.y2 > capture.height) throw Error()
    const target = rectangleSchema.parse({
      x: box.x1 / capture.width, y: box.y1 / capture.height,
      width: (box.x2 - box.x1) / capture.width, height: (box.y2 - box.y1) / capture.height
    })
    return { explanation: result.explanation, captureId: capture.id, target }
  } catch { throw new AppProblem('invalid_target', 'No reliable screen location was returned (' + failure + '). Try a fresh capture. No highlight was shown.') }
}

export function mapRectangle(target: Rectangle, bounds: Rectangle): { desktop: Rectangle; local: Rectangle } {
  const parsed = rectangleSchema.safeParse(target)
  if (!parsed.success || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width <= 0 || bounds.height <= 0) throw new AppProblem('invalid_target', 'The screen location is outside the captured display.')
  const local = { x: target.x * bounds.width, y: target.y * bounds.height,
    width: target.width * bounds.width, height: target.height * bounds.height }
  if (local.width < 1 || local.height < 1) throw new AppProblem('invalid_target', 'The target is too small to mark reliably. Zoom in and capture again.')
  return { local, desktop: { ...local, x: bounds.x + local.x, y: bounds.y + local.y } }
}

// A conservative budget below the standard vision limits keeps coordinate inputs
// unchanged by server resizing. No padding or cropping is introduced.
export function captureSize(width: number, height: number): { width: number; height: number } {
  if (![width, height].every((n) => Number.isFinite(n) && n >= 1)) throw new AppProblem('capture_failed', 'Invalid screen image dimensions.')
  const scale = Math.min(1, 1280 / Math.max(width, height), Math.sqrt(1000000 / (width * height)))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}
