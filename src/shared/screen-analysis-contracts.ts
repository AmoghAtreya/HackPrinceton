import { z } from 'zod'

/**
 * One-off looks at the current screen that return structured help instead of
 * a chat reply:
 * - simplify: "What can I do here?" → a plain summary and 3–5 big task buttons.
 * - safety:   "Is this safe?" → a scam / dark-pattern verdict with reasons.
 * Neither is saved in history; the screenshot is used once and discarded.
 */
export type ScreenAnalysisKind = 'simplify' | 'safety'

export const simplifiedViewSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  actions: z.array(z.object({
    /** Big-button text, task first: "Track my package". */
    label: z.string().trim().min(1).max(48),
    /** What Triage does when pressed: a question about the screen, or the control to point at. */
    instruction: z.string().trim().min(1).max(300),
    kind: z.enum(['show_me_where', 'ask'])
  }).strict()).min(1).max(5)
}).strict()
export type SimplifiedView = z.infer<typeof simplifiedViewSchema>

export const safetyCheckSchema = z.object({
  verdict: z.enum(['looks_safe', 'be_careful', 'likely_scam']),
  headline: z.string().trim().min(1).max(200),
  reasons: z.array(z.string().trim().min(1).max(200)).max(4),
  advice: z.string().trim().min(1).max(300)
}).strict()
export type SafetyCheck = z.infer<typeof safetyCheckSchema>

export type ScreenAnalysis =
  | { kind: 'simplify'; view: SimplifiedView }
  | { kind: 'safety'; check: SafetyCheck }

/** Parses a model's JSON answer for `kind`; returns null when it does not match the schema. */
export function parseScreenAnalysis(kind: ScreenAnalysisKind, text: string): ScreenAnalysis | null {
  let value: unknown
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) }
  catch { return null }
  if (kind === 'simplify') {
    const parsed = simplifiedViewSchema.safeParse(value)
    return parsed.success ? { kind, view: parsed.data } : null
  }
  const parsed = safetyCheckSchema.safeParse(value)
  return parsed.success ? { kind, check: parsed.data } : null
}

/** What Triage says aloud for an analysis. */
export function analysisSpeech(analysis: ScreenAnalysis): string {
  if (analysis.kind === 'simplify') {
    const labels = analysis.view.actions.map((action) => action.label)
    const list = labels.length > 1 ? labels.slice(0, -1).join(', ') + ' or ' + labels.at(-1) : labels[0]
    return `${analysis.view.summary} You can: ${list}. Press a button and I'll help.`
  }
  return `${analysis.check.headline} ${analysis.check.advice}`
}
