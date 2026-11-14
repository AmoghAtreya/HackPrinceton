import { pageTypes, type DistilledPage, type PageType, type SessionContext } from '../../shared/simplifier-contracts.ts'
import type { SkillFeatures } from '../../shared/skill-contracts.ts'

/**
 * Context vector x for the contextual bandit. Every entry is roughly in [-1, 1]
 * so a single prior scale works for all of them.
 *
 * Layout (keep FEATURE_NAMES in sync; the version is logged with every
 * decision so old logs stay interpretable when the layout changes):
 *   0       bias
 *   1..6    page type one-hot
 *   7..9    DOM complexity: interactive count, nav depth, text length (log-scaled)
 *   10..11  time of day (sin, cos)
 *   12      voice on
 *   13      recent error rate
 *   14..17  what the person knows about the skill this kind of page needs
 *
 * Version history. A decision is only ever learned from, replayed or evaluated
 * under the version it was logged with:
 *   1  entries 14..17 were four generic user traits (vision, reading, voice, tech confidence)
 *   2  entries 14..17 are per-skill knowledge from the skill graph (main/skills)
 */
export const FEATURE_VERSION = 2
export const FEATURE_NAMES = [
  'bias',
  ...pageTypes.map((type) => 'page_' + type),
  'interactive_log', 'nav_depth', 'text_log',
  'hour_sin', 'hour_cos',
  'voice_on', 'recent_error_rate',
  'skill_page', 'skill_weakest_prerequisite', 'skill_overall', 'skill_practice'
] as const
export const FEATURE_DIM = FEATURE_NAMES.length

/**
 * Where a learner's saved state lives. Version 1 state stays under the bare
 * name, untouched; later layouts get their own key, so statistics learned
 * under one layout are never loaded into, or overwritten by, another.
 */
export function policyStateKey(policyName: string, featureVersion = FEATURE_VERSION): string {
  return featureVersion === 1 ? policyName : policyName + '@features-v' + featureVersion
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const logScale = (value: number, max: number) => clamp01(Math.log1p(Math.max(0, value)) / Math.log1p(max))

export function contextVector(page: DistilledPage, type: PageType, session: SessionContext, knowledge: SkillFeatures): number[] {
  const hour = new Date(session.now).getHours() + new Date(session.now).getMinutes() / 60
  const angle = (hour / 24) * 2 * Math.PI
  const x = [
    1,
    ...pageTypes.map((candidate) => (candidate === type ? 1 : 0)),
    logScale(page.stats.interactiveElements, 500),
    clamp01(page.stats.maxNavDepth / 6),
    logScale(page.stats.textLength, 50000),
    Math.sin(angle), Math.cos(angle),
    session.voiceEnabled ? 1 : 0,
    clamp01(session.recentErrorRate),
    clamp01(knowledge.page), clamp01(knowledge.weakestPrerequisite), clamp01(knowledge.overall), clamp01(knowledge.practice)
  ]
  if (x.length !== FEATURE_DIM) throw new Error('Feature layout mismatch')
  return x
}
