import { z } from 'zod'
import { elementKinds } from './simplifier-contracts.ts'

// ---------------------------------------------------------------------------
// Context snapshot: the accessibility tree of the frontmost app's focused
// window, flattened in document order by native/context/AXSnapshot.mm. Typed
// VALUES are never captured: `value` exists only for prose (static text and
// headings), and a secure field can never carry one.
// ---------------------------------------------------------------------------

export const CONTEXT_MAX_ELEMENTS = 400
export const CONTEXT_TTL_MS = 30000
export const SECURE_ROLE = 'AXSecureTextField'

const coordinate = z.number().finite().min(-1e6).max(1e6)
const extent = z.number().finite().min(0).max(1e6)
export const contextFrameSchema = z.object({ x: coordinate, y: coordinate, width: extent, height: extent }).strict()
export type ContextFrame = z.infer<typeof contextFrameSchema>

const elementShape = {
  role: z.string().min(1).max(80),
  subrole: z.string().min(1).max(80).optional(),
  label: z.string().max(300),
  value: z.string().max(500).optional(),
  url: z.string().max(2048).optional(),
  frame: contextFrameSchema,
  secure: z.boolean(),
  enabled: z.boolean(),
  /** Number of ancestors that are also in `elements`, so ancestry can be rebuilt from the flat list. */
  depth: z.number().int().min(0).max(CONTEXT_MAX_ELEMENTS)
}

// Defence in depth: even if a native build regressed, a snapshot in which a
// secure field carries a value, or is not flagged secure, fails validation.
const secureIssue = (el: { role: string; subrole?: string; secure: boolean; value?: string }): string | null => {
  if ((el.role === SECURE_ROLE || el.subrole === SECURE_ROLE) && !el.secure) return 'A secure text field must be marked secure.'
  if (el.secure && el.value !== undefined) return 'A secure element must never carry a value.'
  return null
}
const secureCheck = (el: Parameters<typeof secureIssue>[0], ctx: z.RefinementCtx) => {
  const message = secureIssue(el)
  if (message) ctx.addIssue({ code: 'custom', message })
}

export const axElementSchema = z.object(elementShape).strict().superRefine(secureCheck)
export type AxElement = z.infer<typeof axElementSchema>

const snapshotShape = {
  app: z.object({
    bundleId: z.string().max(255),
    name: z.string().max(255),
    pid: z.number().int().min(0).max(2147483647)
  }).strict(),
  window: z.object({ title: z.string().max(500), frame: contextFrameSchema }).strict(),
  url: z.string().min(1).max(4000).optional(),
  focusedElementIndex: z.number().int().min(0).max(CONTEXT_MAX_ELEMENTS - 1).optional()
}
const focusCheck = (snapshot: { focusedElementIndex?: number; elements: unknown[] }, ctx: z.RefinementCtx) => {
  if (snapshot.focusedElementIndex !== undefined && snapshot.focusedElementIndex >= snapshot.elements.length)
    ctx.addIssue({ code: 'custom', message: 'focusedElementIndex must point at an element.' })
}

/** Exactly the JSON that the native module's snapshot() returns. */
export const axSnapshotSchema = z.object({
  ...snapshotShape, elements: z.array(axElementSchema).max(CONTEXT_MAX_ELEMENTS)
}).strict().superRefine(focusCheck)
export type AxSnapshot = z.infer<typeof axSnapshotSchema>

/** An element as features see it: addressable by id, with its role mapped to the simplifier's ElementKind. */
export const contextElementSchema = z.object({
  ...elementShape,
  /** "e<index>". Only meaningful together with the generation of the snapshot it came from. */
  id: z.string().regex(/^e\d{1,3}$/),
  /** null when the role has no ElementKind (containers, images, menus, ...). */
  kind: z.enum(elementKinds).nullable()
}).strict().superRefine(secureCheck)
export type ContextElement = z.infer<typeof contextElementSchema>

export const contextSnapshotSchema = z.object({
  ...snapshotShape,
  elements: z.array(contextElementSchema).max(CONTEXT_MAX_ELEMENTS),
  id: z.uuid(),
  capturedAt: z.number().int().min(0),
  displayId: z.string().max(64),
  generation: z.number().int().min(0)
}).strict().superRefine(focusCheck)
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>
