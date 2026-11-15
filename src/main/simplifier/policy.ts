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
  /** Current chance of choosing each allowed arm here, for display (learning monitor). */
  odds?(input: PolicyInput): Record<string, number>
  /** Learned reward noise E[σ²] and effective number of ratings per arm, for display. */
  diagnostics?(userId: string, armIds: string[]): Record<string, { noiseVariance: number; evidence: number }>
}

const index = (name: typeof FEATURE_NAMES[number]) => FEATURE_NAMES.indexOf(name)

/**
 * Deterministic baseline and fallback ("rules + memory" in the doc's cut
 * order). It reads the person's skill knowledge and voice state straight from
 * the context vector. It never learns.
 *
 * Version 2: chooses by skill knowledge. Version 1 chose by generic user traits.
 */
export class RulesPolicy implements PresentationPolicy {
  readonly name = 'rules'
  readonly version = 2

  private pick(input: PolicyInput): string {
    const allowed = new Set(input.arms.map((arm) => arm.id))
    const x = input.x
    const wanted: string[] = []
    const practice = x[index('skill_practice')] > 0.5
    // New to what this page asks of them, or marked for practice: plain words, one step at a time.
    const novice = practice || x[index('skill_page')] < 0.45
    // Comfortable with it and everything under it: the page's own wording, more choices at once.
    const fluent = !practice && x[index('skill_page')] >= 0.85 && x[index('skill_weakest_prerequisite')] >= 0.45
    if (novice) wanted.push(x[index('voice_on')] > 0.5 ? 'a07' : 'a05')
    if (fluent) wanted.push('a04')
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
