import type { DecisionMode, PageType, PresentationArm } from '../../shared/simplifier-contracts.ts'
import { DEFAULT_ARM_ID } from './arms.ts'
import { FEATURE_NAMES } from './features.ts'

export interface PolicyInput {
  userId: string
  /** Context vector from features.ts. */
  x: number[]
  /** Shielded set of arms the policy may choose from (see arms.allowedArms). */
  arms: PresentationArm[]
  pageType: PageType
  /** Financial or login page: never explore. */
  sensitive: boolean
}

export interface PolicyDecision {
  armId: string
  /** p(a | x) under this policy at decision time. Logged for off-policy evaluation. */
  propensity: number
  mode: DecisionMode
}

/**
 * The single seam every learner plugs into. The rules baseline, the live
 * Thompson Sampling bandit, and later an offline-trained policy (IQL/CQL or a
 * DPO-tuned model) all implement this, so the engine and the decision log do
 * not change when the learner does.
 */
export interface PresentationPolicy {
  readonly name: string
  readonly version: number
  choose(input: PolicyInput): PolicyDecision
  /** Probability this policy would choose armId in this context. Used for IPS / SNIPS evaluation of logged data. */
  probability(input: PolicyInput, armId: string): number
  learn(input: PolicyInput, armId: string, reward: number): void
  serialize(): string
}

const index = (name: typeof FEATURE_NAMES[number]) => FEATURE_NAMES.indexOf(name)

/**
 * Deterministic baseline and fallback ("rules + memory" in the doc's cut
 * order). It reads user traits and voice state straight from the context
 * vector. It never learns.
 */
export class RulesPolicy implements PresentationPolicy {
  readonly name = 'rules'
  readonly version = 1

  private pick(input: PolicyInput): string {
    const allowed = new Set(input.arms.map((arm) => arm.id))
    const x = input.x
    const wanted: string[] = []
    const voice = x[index('voice_on')] > 0.5 && x[index('trait_voice')] > 0.6
    const vision = x[index('trait_vision')] > 0.6
    const reading = x[index('trait_reading')] > 0.6
    if (voice) wanted.push(vision ? 'a10' : 'a07')
    if (vision) wanted.push(reading ? 'a09' : 'a08')
    if (x[index('trait_tech')] > 0.7 && !reading) wanted.push('a04')
    wanted.push(DEFAULT_ARM_ID)
    return wanted.find((id) => allowed.has(id)) ?? input.arms[0].id
  }

  choose(input: PolicyInput): PolicyDecision {
    return { armId: this.pick(input), propensity: 1, mode: 'rules' }
  }
  probability(input: PolicyInput, armId: string): number {
    return this.pick(input) === armId ? 1 : 0
  }
  learn(): void { /* Rules do not learn. */ }
  serialize(): string { return JSON.stringify({ name: this.name, version: this.version }) }
}
