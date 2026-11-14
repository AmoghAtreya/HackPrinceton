import { pageTypes, type DistilledPage, type PageType, type SessionContext, type UserTraits } from '../../shared/simplifier-contracts.ts'

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
 *   14..17  user traits from memory
 */
export const FEATURE_VERSION = 1
export const FEATURE_NAMES = [
  'bias',
  ...pageTypes.map((type) => 'page_' + type),
  'interactive_log', 'nav_depth', 'text_log',
  'hour_sin', 'hour_cos',
  'voice_on', 'recent_error_rate',
  'trait_vision', 'trait_reading', 'trait_voice', 'trait_tech'
] as const
export const FEATURE_DIM = FEATURE_NAMES.length

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const logScale = (value: number, max: number) => clamp01(Math.log1p(Math.max(0, value)) / Math.log1p(max))

export function contextVector(page: DistilledPage, type: PageType, session: SessionContext, traits: UserTraits): number[] {
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
    clamp01(traits.visionSupport), clamp01(traits.readingSupport), clamp01(traits.voicePreference), clamp01(traits.techConfidence)
  ]
  if (x.length !== FEATURE_DIM) throw new Error('Feature layout mismatch')
  return x
}
