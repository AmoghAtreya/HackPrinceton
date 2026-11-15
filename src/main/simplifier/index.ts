import type { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { LearningMonitor } from '../monitor/bus.ts'
import { join } from 'node:path'
import { DecisionLog } from './decision-log.ts'
import { SimplificationEngine } from './engine.ts'
import { ClaudeSimplifier } from './llm.ts'
import { RulesPolicy, type PresentationPolicy } from './policy.ts'
import { ThompsonPolicy, type ThompsonOptions } from './thompson.ts'
import { policyStateKey } from './features.ts'
import type { PageType } from '../../shared/simplifier-contracts.ts'
import type { SkillFeatures } from '../../shared/skill-contracts.ts'

export { SimplificationEngine } from './engine.ts'
export type { SimplifyInput, SimplifyResult } from './engine.ts'
export { DecisionLog } from './decision-log.ts'
export { distillPage, distillDocument } from './distill.ts'
export { evaluateOffPolicy } from './off-policy.ts'
export { RulesPolicy } from './policy.ts'
export type { PresentationPolicy } from './policy.ts'
export { ThompsonPolicy } from './thompson.ts'
export { ClaudeSimplifier } from './llm.ts'
export type { SimplifierModel } from './llm.ts'

/**
 * Wire up the default engine: Claude for the rewrite, the hierarchical
 * Thompson bandit for presentation, both persisted in simplifier.sqlite in
 * the app's data directory. Pass policy: 'rules' to switch learning off (the
 * doc's last-resort cut), keeping the same logging.
 */
export function createSimplifier(dataDirectory: string, options: {
  policy?: 'thompson' | 'rules'; thompson?: Partial<ThompsonOptions>
  /** Per-skill knowledge for the learner's context; see main/skills/tutor.ts. */
  knowledge?: (userId: string, pageType: PageType) => SkillFeatures
  /** Display-only learning monitor and the LangChain callbacks that feed it. */
  monitor?: LearningMonitor
  callbacks?: BaseCallbackHandler[]
} = {}) {
  const log = new DecisionLog(join(dataDirectory, 'simplifier.sqlite'))
  const policy: PresentationPolicy = options.policy === 'rules'
    ? new RulesPolicy()
    : new ThompsonPolicy(options.thompson, Math.random, log.loadPolicy(policyStateKey('thompson')))
  const engine = new SimplificationEngine({ log, policy, model: new ClaudeSimplifier(), knowledge: options.knowledge, monitor: options.monitor, callbacks: options.callbacks })
  return { engine, log, policy, close: () => log.close() }
}
