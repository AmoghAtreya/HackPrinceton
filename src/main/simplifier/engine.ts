import { randomUUID } from 'node:crypto'
import { outcomeSignalsSchema, type DecisionMode, type DistilledPage, type PageType, type PresentationArm, type SimplifiedView, type UserTraits } from '../../shared/simplifier-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { allowedArms, armById } from './arms.ts'
import { classifyPage, isSensitive, rankElements } from './classify.ts'
import type { DecisionLog } from './decision-log.ts'
import { contextVector, FEATURE_VERSION, policyStateKey } from './features.ts'
import { neutralSkillFeatures, type SkillFeatures } from '../../shared/skill-contracts.ts'
import type { SimplifierModel } from './llm.ts'
import { inputFor } from './off-policy.ts'
import type { PresentationPolicy } from './policy.ts'
import { computeReward, REWARD_VERSION } from './reward.ts'
import { finalizeView, rulesView } from './view.ts'
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables'
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { describeLayout } from './arms.ts'
import type { LearningMonitor } from '../monitor/bus.ts'
import type { PolicyDecision, PolicyInput } from './policy.ts'

/** State passed between the named steps of the simplification pipeline. */
interface PipelineState {
  input: SimplifyInput
  signal: AbortSignal
  now: number
  pageType?: PageType
  sensitive?: boolean
  x?: number[]
  policyInput?: PolicyInput
  decision?: PolicyDecision
  arm?: PresentationArm
  view?: SimplifiedView
  result?: SimplifyResult
}

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
  private readonly timeoutSignal: (ms: number) => AbortSignal
  private readonly knowledge: (userId: string, pageType: PageType) => SkillFeatures
  private readonly monitor?: LearningMonitor
  private readonly callbacks: BaseCallbackHandler[]

  constructor(options: {
    log: DecisionLog; policy: PresentationPolicy; model?: SimplifierModel; llmTimeoutMs?: number; now?: () => number
    /** Source of the LLM deadline signal. Injectable so tests can fire the timeout instantly instead of waiting. */
    timeoutSignal?: (ms: number) => AbortSignal
    /** What the person knows about the skill a page of this type needs (the skill graph). Neutral when absent. */
    knowledge?: (userId: string, pageType: PageType) => SkillFeatures
    /** Display-only: publishes decisions, layout odds and rewards to the learning monitor. */
    monitor?: LearningMonitor
    /** LangChain callbacks (e.g. the monitor's) attached to every pipeline run. */
    callbacks?: BaseCallbackHandler[]
  }) {
    this.monitor = options.monitor
    this.callbacks = options.callbacks ?? []
    this.knowledge = options.knowledge ?? (() => neutralSkillFeatures)
    this.log = options.log
    this.policy = options.policy
    this.model = options.model
    this.llmTimeoutMs = options.llmTimeoutMs ?? 20000
    this.now = options.now ?? Date.now
    this.timeoutSignal = options.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms))
  }

  /**
   * The pipeline as LangChain runnables: four named steps in a
   * RunnableSequence. Running it through LangChain gives every simplification
   * a traced run (one child per step) that callbacks such as the learning
   * monitor receive, alongside the LangGraph task graphs and memory retrievals.
   */
  private readonly pipeline = RunnableSequence.from<PipelineState, PipelineState>([
    this.step('classify_page', async (state) => {
      const page = state.input.page
      const pageType = classifyPage(page)
      const x = contextVector(page, pageType, {
        userId: state.input.userId, now: state.now, voiceEnabled: state.input.voiceEnabled, recentErrorRate: this.log.recentErrorRate(state.input.userId)
      }, this.knowledge(state.input.userId, pageType))
      return { ...state, pageType, sensitive: isSensitive(pageType), x }
    }),
    this.step('choose_layout', async (state) => {
      const policyInput: PolicyInput = { userId: state.input.userId, x: state.x!, arms: allowedArms(state.input.voiceEnabled), pageType: state.pageType!, sensitive: state.sensitive! }
      const decision = this.policy.choose(policyInput)
      this.log.savePolicy(policyStateKey(this.policy.name), this.policy.serialize(), state.now)
      return { ...state, policyInput, decision, arm: armById(decision.armId) }
    }),
    this.step('rewrite_page', async (state) => {
      const { input, signal, arm, pageType } = state
      const ranked = rankElements(input.page)
      let view: SimplifiedView
      if (this.model && input.credentials) {
        const timeout = this.timeoutSignal(this.llmTimeoutMs)
        try {
          const draft = await this.model.simplify({
            key: input.credentials.key, model: input.credentials.model, page: input.page, ranked, pageType: pageType!, arm: arm!,
            signal: AbortSignal.any([signal, timeout])
          })
          view = finalizeView(draft, input.page, ranked, arm!)
        } catch {
          if (signal.aborted) throw new AppProblem('stopped', 'Simplification stopped.')
          // Model failure must never leave the user with nothing: fall back to rules.
          view = rulesView(input.page, ranked, arm!)
        }
      } else view = rulesView(input.page, ranked, arm!)
      if (signal.aborted) throw new AppProblem('stopped', 'Simplification stopped.')
      return { ...state, view }
    }),
    this.step('log_decision', async (state) => {
      const { input, decision, arm, view, pageType } = state
      const episodeId = input.episodeId ?? randomUUID()
      let pageHost = ''
      try { pageHost = new URL(input.page.url).hostname } catch { /* Keep empty. */ }
      const decisionId = this.log.record({
        userId: input.userId, episodeId, step: this.log.nextStep(episodeId), pageType: pageType!, pageHost,
        featureVersion: FEATURE_VERSION, x: state.x!, armId: arm!.id, propensity: decision!.propensity, mode: decision!.mode,
        policyName: this.policy.name, policyVersion: this.policy.version, viewSource: view!.source,
        sensitive: state.sensitive!, voiceEnabled: input.voiceEnabled
      }, state.now)
      return { ...state, result: { decisionId, episodeId, pageType: pageType!, arm: arm!, mode: decision!.mode, view: view! } }
    })
  ]).withConfig({ runName: 'simplify_page', tags: ['triage-step'] })

  private step(name: string, fn: (state: PipelineState) => Promise<PipelineState>) {
    return RunnableLambda.from(fn).withConfig({ runName: name, tags: ['triage-step'] })
  }

  async simplify(input: SimplifyInput): Promise<SimplifyResult> {
    const signal = input.signal ?? new AbortController().signal
    if (signal.aborted) throw new AppProblem('stopped', 'Simplification stopped.')
    const state = await this.pipeline.invoke({ input, signal, now: this.now() }, { callbacks: this.callbacks })
    const result = state.result!
    if (this.monitor) {
      this.monitor.emit({
        type: 'bandit', pageType: result.pageType, armId: result.arm.id, layout: describeLayout(result.arm.id),
        propensity: state.decision!.propensity, mode: result.mode, shares: this.policy.odds?.(state.policyInput!) ?? { [result.arm.id]: 1 },
        source: result.view.source,
        ...(this.policy.diagnostics ? { diagnostics: this.policy.diagnostics(input.userId, state.policyInput!.arms.map((arm) => arm.id)) } : {})
      })
    }
    return result
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
      this.log.savePolicy(policyStateKey(this.policy.name), this.policy.serialize(), this.now())
    }
    if (this.monitor) {
      const stats = this.log.ratingStats(decision.userId)
      this.monitor.emit({ type: 'reward', armId: decision.armId, layout: describeLayout(decision.armId), pageType: decision.pageType, reward, rated: stats.rated, averageReward: stats.averageReward })
    }
    return reward
  }

  /**
   * Legacy: generic traits fed the learner under feature version 1. They are kept
   * readable for old records but no longer influence decisions; see main/skills.
   */
  setTraits(userId: string, traits: Partial<UserTraits>): UserTraits {
    return this.log.setTraits(userId, traits, this.now())
  }
}
