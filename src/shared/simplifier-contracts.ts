import { z } from 'zod'

// ---------------------------------------------------------------------------
// Distilled page: what the browser hands to the simplifier. It is a compact,
// accessibility-tree-like view of the visible page. Input VALUES are never
// captured, only labels, so typed passwords or card numbers cannot leak.
// ---------------------------------------------------------------------------

export const elementKinds = ['button', 'link', 'input', 'select', 'textarea', 'checkbox', 'radio', 'heading', 'text'] as const
export type ElementKind = typeof elementKinds[number]
export const pageRegions = ['main', 'header', 'nav', 'aside', 'footer', 'dialog', 'other'] as const
export type PageRegion = typeof pageRegions[number]

export const pageElementSchema = z.object({
  id: z.string().regex(/^e\d{1,5}$/),
  kind: z.enum(elementKinds),
  label: z.string().max(300),
  region: z.enum(pageRegions),
  inputType: z.string().max(40).optional(),
  autocomplete: z.string().max(80).optional(),
  href: z.string().max(2000).optional(),
  level: z.number().int().min(1).max(6).optional(),
  area: z.number().finite().min(0).max(1),
  top: z.number().finite().min(0)
}).strict()
export type PageElement = z.infer<typeof pageElementSchema>

export const distilledPageSchema = z.object({
  url: z.string().max(4000),
  title: z.string().max(500),
  lang: z.string().max(20),
  elements: z.array(pageElementSchema).max(400),
  mainText: z.string().max(20000),
  stats: z.object({
    totalElements: z.number().int().min(0),
    interactiveElements: z.number().int().min(0),
    maxNavDepth: z.number().int().min(0),
    textLength: z.number().int().min(0),
    hiddenRemoved: z.number().int().min(0)
  }).strict(),
  capturedAt: z.number().int()
}).strict()
export type DistilledPage = z.infer<typeof distilledPageSchema>

// ---------------------------------------------------------------------------
// Page classification. Financial and login pages are "sensitive": the policy
// never explores there and the scam guard must be green for tier-4 actions.
// ---------------------------------------------------------------------------

export const pageTypes = ['article', 'form', 'checkout', 'login', 'email', 'other'] as const
export type PageType = typeof pageTypes[number]

/** Action safety tiers from the design doc. Always assigned by rules, never by the LLM. */
// A plain object, not an enum, so the file still runs under node --experimental-strip-types.
export const RiskTier = { Read: 0, Navigate: 1, EnterData: 2, Commit: 3, MoneyOrCredentials: 4 } as const
export type RiskTier = typeof RiskTier[keyof typeof RiskTier]

// ---------------------------------------------------------------------------
// Presentation arms: the discrete choices the bandit makes. IDs are part of
// the logged dataset, so never rename or reuse an ID; add new ones instead.
// ---------------------------------------------------------------------------

export interface PresentationArm {
  id: string
  fontScale: 1.25 | 1.5 | 2
  maxActions: 3 | 6
  plainLanguage: boolean
  voiceNarration: boolean
  verbosity: 'terse' | 'step_by_step'
}

// ---------------------------------------------------------------------------
// LLM output. The model may only reference element IDs that exist in the
// distilled page; risk tiers are attached afterwards by rules.
// ---------------------------------------------------------------------------

export const simplifiedActionSchema = z.object({
  elementId: z.string().regex(/^e\d{1,5}$/).describe('ID of an element from the supplied page elements. Never invent IDs.'),
  label: z.string().trim().min(1).max(60).describe('Short, plain button text in everyday words, e.g. "Next" or "Refill prescription".'),
  hint: z.string().trim().max(160).describe('One short sentence saying what happens when pressed. Empty string if obvious.')
}).strict()

export const simplifiedViewSchema = z.object({
  title: z.string().trim().min(1).max(120).describe('Big, plain title for the page.'),
  purpose: z.string().trim().min(1).max(240).describe('One sentence: what this page is for.'),
  summary: z.array(z.string().trim().min(1).max(400)).max(8).describe('Key points from the page, in reading order.'),
  actions: z.array(simplifiedActionSchema).max(6).describe('The most useful things the person can do here, most important first.'),
  narration: z.string().trim().max(1200).describe('Text to read aloud. Empty string when voice narration is off.'),
  concerns: z.array(z.string().trim().min(1).max(240)).max(4).describe('Anything that looks risky or confusing (urgent demands, requests for passwords or payment). Empty if none.')
}).strict()
export type SimplifiedViewDraft = z.infer<typeof simplifiedViewSchema>

export interface SimplifiedAction {
  elementId: string
  label: string
  hint: string
  originalLabel: string
  tier: RiskTier
}
export interface SimplifiedView {
  title: string
  purpose: string
  summary: string[]
  actions: SimplifiedAction[]
  narration: string
  concerns: string[]
  source: 'llm' | 'rules'
}

// ---------------------------------------------------------------------------
// Interaction outcome signals, collected implicitly by the UI after a view is
// shown. They are turned into a scalar reward in reward.ts.
// ---------------------------------------------------------------------------

export const outcomeSignalsSchema = z.object({
  taskCompleted: z.boolean(),
  durationMs: z.number().finite().min(0).max(24 * 3600 * 1000),
  backtracks: z.number().int().min(0).max(1000),
  thumbsUp: z.boolean().nullable(),
  showedOriginal: z.boolean(),
  repeatRequests: z.number().int().min(0).max(1000)
}).strict()
export type OutcomeSignals = z.infer<typeof outcomeSignalsSchema>

/** Live session context that is not part of the page itself. */
export interface SessionContext {
  userId: string
  now: number
  voiceEnabled: boolean
  /** Fraction of the user's recent interactions that ended in errors or backtracking, 0..1. */
  recentErrorRate: number
}

/** Long-lived user traits from memory, all normalised to 0..1 (0.5 = unknown). */
export interface UserTraits {
  visionSupport: number
  readingSupport: number
  voicePreference: number
  techConfidence: number
}
export const defaultTraits: UserTraits = { visionSupport: 0.5, readingSupport: 0.5, voicePreference: 0.5, techConfidence: 0.5 }

export type DecisionMode = 'explore' | 'exploit' | 'frozen' | 'shielded' | 'rules'
