import type { DistilledPage, PageElement, PresentationArm, SimplifiedAction, SimplifiedView, SimplifiedViewDraft } from '../../shared/simplifier-contracts.ts'
import { riskTier } from './classify.ts'

function toAction(el: PageElement, page: DistilledPage, label = el.label, hint = ''): SimplifiedAction {
  return { elementId: el.id, label: label.slice(0, 60) || el.kind, hint, originalLabel: el.label, tier: riskTier(el, page) }
}

/**
 * Turn an LLM draft into a view the UI can trust:
 * - drops actions whose element ID is not on the page, and duplicates,
 * - enforces the arm's action budget,
 * - backfills from the ranked list if the model returned too few usable actions,
 * - attaches rule-based risk tiers (the model never sets these),
 * - clears narration when the arm has voice off.
 */
export function finalizeView(draft: SimplifiedViewDraft, page: DistilledPage, ranked: PageElement[], arm: PresentationArm): SimplifiedView {
  const byId = new Map(page.elements.map((el) => [el.id, el]))
  const seen = new Set<string>()
  const actions: SimplifiedAction[] = []
  for (const action of draft.actions) {
    const el = byId.get(action.elementId)
    if (!el || seen.has(el.id) || el.kind === 'heading' || el.kind === 'text') continue
    seen.add(el.id)
    actions.push(toAction(el, page, action.label, action.hint))
    if (actions.length >= arm.maxActions) break
  }
  const minimum = Math.min(arm.maxActions, 2)
  for (const el of ranked) {
    if (actions.length >= minimum) break
    if (seen.has(el.id)) continue
    seen.add(el.id)
    actions.push(toAction(el, page))
  }
  return {
    title: draft.title, purpose: draft.purpose, summary: draft.summary.slice(0, arm.verbosity === 'terse' ? 4 : 8),
    actions, narration: arm.voiceNarration ? draft.narration : '', concerns: draft.concerns, source: 'llm'
  }
}

/** Deterministic view with no LLM: used when the model is unavailable, slow, or returns junk. */
export function rulesView(page: DistilledPage, ranked: PageElement[], arm: PresentationArm): SimplifiedView {
  const heading = page.elements.find((el) => el.kind === 'heading' && el.level === 1) ?? page.elements.find((el) => el.kind === 'heading')
  const title = (heading?.label || page.title || 'This page').slice(0, 120)
  const sentences = page.mainText.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 30)
  const summary = sentences.slice(0, arm.verbosity === 'terse' ? 2 : 4).map((s) => s.slice(0, 400))
  const actions = ranked.slice(0, arm.maxActions).map((el) => toAction(el, page))
  const narration = arm.voiceNarration ? [title + '.', ...summary.slice(0, 1), actions.length ? 'You can choose: ' + actions.map((a) => a.label).join(', ') + '.' : ''].join(' ').trim() : ''
  return { title, purpose: page.title.slice(0, 240) || title, summary, actions, narration, concerns: [], source: 'rules' }
}
