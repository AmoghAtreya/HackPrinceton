import { frameProbeSchema, type ContextSnapshot } from '../../shared/context-contracts.ts'
import type { FrameReading, LocateElement } from '../../shared/highlight-contracts.ts'
import { redact } from '../assistant/redaction.ts'
import { rankElements } from '../simplifier/classify.ts'
import { toDistilledPage } from './distilled.ts'

export const LOCATE_ELEMENT_LIMIT = 60
const LOCATE_LABEL_LIMIT = 120

/**
 * The compact element list sent with a "where do I click" request: the most
 * relevant actionable elements, as id / kind / label / region. Labels only -
 * the snapshot holds no typed values, and nothing else about an element is sent.
 */
export function locateElements(snapshot: ContextSnapshot, limit = LOCATE_ELEMENT_LIMIT): LocateElement[] {
  return rankElements(toDistilledPage(snapshot)).slice(0, limit).map(({ id, kind, label, region }) => ({
    id, kind, label: redact(label).slice(0, LOCATE_LABEL_LIMIT), region
  }))
}

/** Parses what the native frameOf() returned. Anything malformed reads as "element gone". */
export function readFrame(output: string): FrameReading {
  try {
    const probe = frameProbeSchema.parse(JSON.parse(output))
    return { frontmost: probe.frontmost, frame: probe.frame, ...(probe.role ? { role: probe.role } : {}) }
  } catch { return { frontmost: true, frame: null } }
}
