import { randomUUID } from 'node:crypto'
import { outcomeSignalsSchema, type DecisionMode, type DistilledPage, type PageType, type PresentationArm, type SimplifiedView, type UserTraits } from '../../shared/simplifier-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { allowedArms, armById } from './arms.ts'
import { classifyPage, isSensitive, rankElements } from './classify.ts'
import type { DecisionLog } from './decision-log.ts'
import { contextVector, FEATURE_VERSION } from './features.ts'
import type { SimplifierModel } from './llm.ts'
import { inputFor } from './off-policy.ts'
import type { PresentationPolicy } from './policy.ts'
import { computeReward, REWARD_VERSION } from './reward.ts'
import { finalizeView, rulesView } from './view.ts'

export interface SimplifyInput {
  page: DistilledPage
  userId: string
  voiceEnabled: boolean
  /** Groups consecutive pages of one task into an episode (trajectory) for later offline RL. */
  episodeId?: string
  /** Omit to get the rules-only view (no network). */
  credentials?: { key: string; model: string }
  signal?: AbortSignal
}

export interface SimplifyResult {
  decisionId: string
  episodeId: string
  pageType: PageType
  arm: PresentationArm
  mode: DecisionMode
  view: SimplifiedView
}

/**
 * Orchestrates one simplification:
 *
 *   distilled page → rules classify → context x → policy picks arm (logged with propensity)
 *     → LLM rewrites page under that arm (rules fallback) → validated view
 *
 * and later, when the UI reports what happened:
 *
 *   outcome signals → reward → policy.learn → reward written to the decision log
 *
 * Swapping the learner (rules → Thompson → offline-trained policy) or the
 * model (Claude → anything implementing SimplifierModel) does not change this
 * class or the log format.
 */
export class SimplificationEngine {
  private readonly log: DecisionLog
  private readonly policy: PresentationPolicy
  private readonly model?: SimplifierModel
  private readonly llmTimeoutMs: number
  private readonly now: () => number

  constructor(options: { log: DecisionLog; policy: PresentationPolicy; model?: SimplifierModel; llmTimeoutMs?: number; now?: () => number }) {
    this.log = options.log
    this.policy = options.policy
    this.model = options.model
    this.llmTimeoutMs = options.llmTimeoutMs ?? 20000
    this.now = options.now ?? Date.now
  }

  async simplify(input: SimplifyInput): Promise<SimplifyResult> {
    const signal = input.signal ?? new AbortController().signal
    if (signal.aborted) throw new AppProblem('stopped', 'Simplification stopped.')
    const page = input.page
    const pageType = classifyPage(page)
    const sensitive = isSensitive(pageType)
    const traits = this.log.traits(input.userId)
    const now = this.now()
    const x = contextVector(page, pageType, {
      userId: input.userId, now, voiceEnabled: input.voiceEnabled, recentErrorRate: this.log.recentErrorRate(input.userId)
    }, traits)
    const policyInput = { userId: input.userId, x, arms: allowedArms(input.voiceEnabled), pageType, sensitive }
    const decision = this.policy.choose(policyInput)
    this.log.savePolicy(this.policy.name, this.policy.serialize(), now)
    const arm = armById(decision.armId)
    const ranked = rankElements(page)

    let view: SimplifiedView
    if (this.model && input.credentials) {
      const timeout = AbortSignal.timeout(this.llmTimeoutMs)
      try {
        const draft = await this.model.simplify({
          key: input.credentials.key, model: input.credentials.model, page, ranked, pageType, arm,
          signal: AbortSignal.any([signal, timeout])
        })
        view = finalizeView(draft, page, ranked, arm)
      } catch (error) {
        if (signal.aborted) throw new AppProblem('stopped', 'Simplification stopped.')
        // Model failure must never leave the user with nothing: fall back to rules.
        view = rulesView(page, ranked, arm)
      }
    } else view = rulesView(page, ranked, arm)
    if (signal.aborted) throw new AppProblem('stopped', 'Simplification stopped.')

    const episodeId = input.episodeId ?? randomUUID()
    let pageHost = ''
    try { pageHost = new URL(page.url).hostname } catch { /* Keep empty. */ }
    const decisionId = this.log.record({
      userId: input.userId, episodeId, step: this.log.nextStep(episodeId), pageType, pageHost,
      featureVersion: FEATURE_VERSION, x, armId: arm.id, propensity: decision.propensity, mode: decision.mode,
      policyName: this.policy.name, policyVersion: this.policy.version, viewSource: view.source,
      sensitive, voiceEnabled: input.voiceEnabled
    }, now)
    return { decisionId, episodeId, pageType, arm, mode: decision.mode, view }
  }

  /**
   * Report what happened after a view was shown. Returns the reward, or null
   * if the decision is unknown or was already rewarded (rewards are write-once,
   * so a double report can never double-train the policy).
   */
  reportOutcome(decisionId: string, rawSignals: unknown): number | null {
    const signals = outcomeSignalsSchema.parse(rawSignals)
    const decision = this.log.get(decisionId)
    if (!decision || decision.reward !== null) return null
    const reward = computeReward(signals, decision.pageType)
    if (!this.log.reward(decisionId, reward, REWARD_VERSION, signals, this.now())) return null
    if (decision.featureVersion === FEATURE_VERSION) {
      this.policy.learn(inputFor(decision), decision.armId, reward)
      this.log.savePolicy(this.policy.name, this.policy.serialize(), this.now())
    }
    return reward
  }

  /** Update what memory knows about the person (e.g. from settings or a caregiver). */
  setTraits(userId: string, traits: Partial<UserTraits>): UserTraits {
    return this.log.setTraits(userId, traits, this.now())
  }
}
