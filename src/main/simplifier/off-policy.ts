import { allowedArms } from './arms.ts'
import { FEATURE_VERSION } from './features.ts'
import type { LoggedDecision } from './decision-log.ts'
import type { PolicyInput, PresentationPolicy } from './policy.ts'
import { addOuter, cholesky, dot, identity, solveCholesky } from './linalg.ts'

export interface OffPolicyEstimate {
  /** Inverse propensity scoring: unbiased, can be high-variance. */
  ips: number
  /** Self-normalised IPS: slightly biased, much more stable on small logs. */
  snips: number
  /** Average reward the logging policy actually got, for comparison. */
  logged: number
  /**
   * IPS with importance weights capped at `clip` (Bottou et al., JMLR 2013;
   * Ionides 2008): trades a little bias for much lower variance.
   */
  clippedIps: number
  /**
   * Doubly robust (Dudík, Langford & Li, ICML 2011): a per-arm ridge reward
   * model predicts every arm, and importance-weighted residuals correct it.
   * Unbiased if either the reward model or the logged propensities are right.
   */
  doublyRobust: number
  /** Effective sample size of the importance weights; low means "don't trust this yet". */
  effectiveSampleSize: number
  n: number
}

export function inputFor(decision: LoggedDecision): PolicyInput {
  return {
    userId: decision.userId, x: decision.x, pageType: decision.pageType,
    sensitive: decision.sensitive, arms: allowedArms(decision.voiceEnabled)
  }
}

/**
 * Estimate how a candidate policy WOULD have done on logged traffic, without
 * showing it to any user. This is how a new bandit configuration or an
 * offline-trained policy is vetted before it goes live.
 *
 * Only decisions logged with the current feature layout are used.
 */
/** Per-arm ridge regression r̂(x, a) fitted on the logs: the "direct method" model inside DR. */
export function fitRewardModel(decisions: LoggedDecision[], ridge = 1): (x: number[], armId: string) => number {
  const byArm = new Map<string, LoggedDecision[]>()
  for (const decision of decisions) byArm.set(decision.armId, [...(byArm.get(decision.armId) ?? []), decision])
  const overall = decisions.length ? decisions.reduce((sum, d) => sum + d.reward!, 0) / decisions.length : 0.5
  const weights = new Map<string, number[]>()
  for (const [armId, rows] of byArm) {
    const dim = rows[0].x.length
    const precision = identity(dim, ridge)
    const rhs = new Array<number>(dim).fill(0)
    for (const row of rows) {
      addOuter(precision, row.x)
      for (let i = 0; i < dim; i++) rhs[i] += row.x[i] * (row.reward! - overall)
    }
    weights.set(armId, solveCholesky(cholesky(precision, dim), rhs, dim))
  }
  return (x, armId) => {
    const w = weights.get(armId)
    return Math.max(0, Math.min(1, overall + (w ? dot(w, x) : 0)))
  }
}

/**
 * Estimate how a candidate policy WOULD have done on logged traffic, without
 * showing it to any user. This is how a new bandit configuration or an
 * offline-trained policy is vetted before it goes live.
 *
 * Only decisions logged with the current feature layout are used.
 */
export function evaluateOffPolicy(target: PresentationPolicy, decisions: LoggedDecision[], options: { clip?: number } = {}): OffPolicyEstimate {
  const clip = options.clip ?? 10
  const usable = decisions.filter((d) => d.reward !== null && d.featureVersion === FEATURE_VERSION && d.propensity > 0)
  const model = fitRewardModel(usable)
  let weighted = 0, weightSum = 0, weightSquares = 0, logged = 0, clipped = 0, doublyRobust = 0
  for (const decision of usable) {
    const input = inputFor(decision)
    const probabilities = target.odds?.(input)
      ?? Object.fromEntries(input.arms.map((arm) => [arm.id, target.probability(input, arm.id)]))
    const weight = (probabilities[decision.armId] ?? 0) / decision.propensity
    const reward = decision.reward!
    weighted += weight * reward
    clipped += Math.min(weight, clip) * reward
    weightSum += weight
    weightSquares += weight * weight
    logged += reward
    let direct = 0
    for (const arm of input.arms) direct += (probabilities[arm.id] ?? 0) * model(decision.x, arm.id)
    doublyRobust += direct + weight * (reward - model(decision.x, decision.armId))
  }
  const n = usable.length
  return {
    ips: n ? weighted / n : 0,
    snips: weightSum ? weighted / weightSum : 0,
    clippedIps: n ? clipped / n : 0,
    doublyRobust: n ? doublyRobust / n : 0,
    logged: n ? logged / n : 0,
    effectiveSampleSize: weightSquares ? (weightSum * weightSum) / weightSquares : 0,
    n
  }
}
