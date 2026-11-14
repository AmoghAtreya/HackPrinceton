import type { OutcomeSignals, PageType } from '../../shared/simplifier-contracts.ts'

/**
 * Expected time to finish a page by type, used to normalise duration. These
 * are starting guesses; replace them with per-page-type medians from the
 * decision log once there is data.
 */
export const EXPECTED_MS: Record<PageType, number> = {
  article: 120_000, form: 180_000, checkout: 180_000, login: 60_000, email: 90_000, other: 90_000
}

export const REWARD_VERSION = 1

/**
 * Scalar reward in [0, 1] from implicit signals (design doc formula):
 *   0.5·task_completed + 0.2·(1 − normalized_time) + 0.15·no_backtrack + 0.15·thumbs_up
 *   − penalties for "show me the original page" and "repeat that".
 *
 * A missing thumbs rating counts as neutral (0.5) so that users who never rate
 * are not treated as unhappy. Time beyond 2× the expectation counts as fully slow.
 */
export function computeReward(signals: OutcomeSignals, type: PageType): number {
  const normalizedTime = Math.min(signals.durationMs / (2 * EXPECTED_MS[type]), 1)
  const noBacktrack = signals.backtracks === 0 ? 1 : signals.backtracks === 1 ? 0.5 : 0
  const thumbs = signals.thumbsUp === null ? 0.5 : signals.thumbsUp ? 1 : 0
  const base = 0.5 * (signals.taskCompleted ? 1 : 0) + 0.2 * (1 - normalizedTime) + 0.15 * noBacktrack + 0.15 * thumbs
  const penalty = (signals.showedOriginal ? 0.25 : 0) + Math.min(signals.repeatRequests, 3) * 0.05
  return Math.max(0, Math.min(1, base - penalty))
}
