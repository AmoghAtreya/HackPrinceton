import { allowedArms } from './arms.ts'
import { FEATURE_VERSION } from './features.ts'
import type { LoggedDecision } from './decision-log.ts'
import type { PolicyInput, PresentationPolicy } from './policy.ts'

export interface OffPolicyEstimate {
  /** Inverse propensity scoring: unbiased, can be high-variance. */
  ips: number
  /** Self-normalised IPS: slightly biased, much more stable on small logs. */
  snips: number
  /** Average reward the logging policy actually got, for comparison. */
  logged: number
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
export function evaluateOffPolicy(target: PresentationPolicy, decisions: LoggedDecision[]): OffPolicyEstimate {
  const usable = decisions.filter((d) => d.reward !== null && d.featureVersion === FEATURE_VERSION && d.propensity > 0)
  let weighted = 0
  let weightSum = 0
  let weightSquares = 0
  let logged = 0
  for (const decision of usable) {
    const weight = target.probability(inputFor(decision), decision.armId) / decision.propensity
    weighted += weight * decision.reward!
    weightSum += weight
    weightSquares += weight * weight
    logged += decision.reward!
  }
  const n = usable.length
  return {
    ips: n ? weighted / n : 0,
    snips: weightSum ? weighted / weightSum : 0,
    logged: n ? logged / n : 0,
    effectiveSampleSize: weightSquares ? (weightSum * weightSum) / weightSquares : 0,
    n
  }
}
