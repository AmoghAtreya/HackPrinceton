import type { ModelChoice } from '../../shared/assistant-contracts.ts'

// Which model a request goes to. Routing and short replies do not need the
// strongest model; anything that reads an image, locates a control or rewrites
// a page does. Only models already listed for the user's key are ever chosen.

export type ModelTier = 'fast' | 'strong'
export type RequestPurpose = 'route' | 'reply' | 'vision' | 'locate' | 'simplify'
export interface ModelPick { model: string; tier: ModelTier }

const PURPOSE_TIER: Record<RequestPurpose, ModelTier> = { route: 'fast', reply: 'fast', vision: 'strong', locate: 'strong', simplify: 'strong' }
export function tierFor(purpose: RequestPurpose): ModelTier { return PURPOSE_TIER[purpose] }

const isFast = (id: string) => /haiku/i.test(id)
/** The list comes from Anthropic newest first; prefer the current naming (claude-haiku-*) over older ids that merely contain the word. */
function firstMatch(models: readonly ModelChoice[], family: 'haiku' | 'sonnet'): string | undefined {
  return (models.find((model) => model.id.startsWith('claude-' + family + '-')) ?? models.find((model) => model.id.toLowerCase().includes(family)))?.id
}

/**
 * - fast: a Haiku model when "Use faster model for simple requests" is on and
 *   one is listed; otherwise the selected model.
 * - strong: the selected model, unless the person selected a Haiku model, in
 *   which case a listed Sonnet model. A deliberate choice of a stronger model
 *   is never replaced by Sonnet.
 * Falls back to the selected model whenever nothing listed matches.
 */
export function pickModel(purpose: RequestPurpose, models: readonly ModelChoice[], selected: string, useFast: boolean): ModelPick {
  const tier = tierFor(purpose)
  if (tier === 'fast') return { tier, model: (useFast ? firstMatch(models, 'haiku') : undefined) ?? selected }
  return { tier, model: isFast(selected) ? firstMatch(models, 'sonnet') ?? selected : selected }
}
