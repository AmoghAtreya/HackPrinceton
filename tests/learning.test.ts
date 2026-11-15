import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gammaSample, seededRandom } from '../src/main/simplifier/linalg.ts'
import { ThompsonPolicy } from '../src/main/simplifier/thompson.ts'
import { allowedArms } from '../src/main/simplifier/arms.ts'
import { contextVector, FEATURE_DIM, FEATURE_VERSION } from '../src/main/simplifier/features.ts'
import { evaluateOffPolicy } from '../src/main/simplifier/off-policy.ts'
import { RulesPolicy } from '../src/main/simplifier/policy.ts'
import type { LoggedDecision } from '../src/main/simplifier/decision-log.ts'
import type { DistilledPage } from '../src/shared/simplifier-contracts.ts'
import { neutralSkillFeatures } from '../src/shared/skill-contracts.ts'

const page: DistilledPage = {
  url: 'https://news.example/a', title: 'News', lang: 'en', mainText: 'x'.repeat(2000), capturedAt: 0, elements: [],
  stats: { totalElements: 100, interactiveElements: 20, maxNavDepth: 2, textLength: 5000, hiddenRemoved: 0 }
}
const x = contextVector(page, 'article', { userId: 'u', now: Date.UTC(2026, 10, 14, 15), voiceEnabled: false, recentErrorRate: 0 }, neutralSkillFeatures)
const input = (userId = 'u', sensitive = true) => ({ userId, x, arms: allowedArms(false), pageType: 'article' as const, sensitive })
const noRandom = () => { throw new Error('random must not be used') }

test('gamma sampler has the right mean (Marsaglia-Tsang)', () => {
  const random = seededRandom(11)
  for (const shape of [0.5, 3, 10]) {
    let sum = 0
    for (let i = 0; i < 4000; i++) sum += gammaSample(shape, random)
    assert.ok(Math.abs(sum / 4000 - shape) < shape * 0.06 + 0.02, `shape ${shape}: mean ${sum / 4000}`)
  }
})

test('the noise posterior is tighter for consistent ratings than for erratic ones', () => {
  const policy = new ThompsonPolicy({ discount: 1 }, noRandom)
  for (let i = 0; i < 30; i++) {
    policy.learn(input('steady'), 'a08', 0.8)
    policy.learn(input('erratic'), 'a08', i % 2 ? 1 : 0)
  }
  const steady = policy.diagnostics('steady', ['a08']).a08
  const erratic = policy.diagnostics('erratic', ['a08']).a08
  assert.ok(steady.noiseVariance < erratic.noiseVariance / 3, `${steady.noiseVariance} vs ${erratic.noiseVariance}`)
  assert.equal(Math.round(steady.evidence), 30)
})

test('discounting follows a change in preference that a non-discounted model misses', () => {
  const run = (discount: number) => {
    const policy = new ThompsonPolicy({ discount }, noRandom)
    for (let i = 0; i < 40; i++) { policy.learn(input(), 'a08', 0.9); policy.learn(input(), 'a09', 0.3) }
    for (let i = 0; i < 15; i++) { policy.learn(input(), 'a08', 0.1); policy.learn(input(), 'a09', 0.9) }
    return policy.choose(input()).armId
  }
  assert.equal(run(1), 'a08', 'without forgetting, 40 old ratings outvote 15 new ones')
  assert.equal(run(0.9), 'a09', 'with forgetting, the recent preference wins')
})

test('saved v1 states (no Σr²) still restore and decide', () => {
  const d = FEATURE_DIM
  const stats = { xtx: new Array(d * d).fill(0), xtr: new Array(d).fill(0), n: 0 }
  const v1 = JSON.stringify({ name: 'thompson', version: 1, featureVersion: FEATURE_VERSION, dim: d, population: { a06: stats }, users: { u: { arms: { a06: stats }, counts: { article: 5 }, frozen: {} } } })
  const policy = new ThompsonPolicy({ propensitySamples: 20 }, seededRandom(2), v1)
  const decision = policy.choose(input('u', false))
  assert.ok(decision.propensity > 0 && decision.propensity <= 1)
})

test('doubly robust and clipped IPS agree with the logged reward when evaluating the logging policy', () => {
  const rules = new RulesPolicy()
  const armId = rules.choose(input('u', false)).armId
  const decisions: LoggedDecision[] = [0.9, 0.4, 0.7, 0.2].map((reward, i) => ({
    id: 'd' + i, userId: 'u', episodeId: 'e' + i, step: 0, createdAt: i, pageType: 'article', pageHost: 'news.example',
    featureVersion: FEATURE_VERSION, x, armId, propensity: 1, mode: 'rules', policyName: 'rules', policyVersion: 1,
    viewSource: 'rules', sensitive: false, voiceEnabled: false, reward, rewardVersion: 1, signals: null
  }))
  const estimate = evaluateOffPolicy(rules, decisions)
  assert.ok(Math.abs(estimate.doublyRobust - estimate.logged) < 1e-9)
  assert.ok(Math.abs(estimate.clippedIps - estimate.logged) < 1e-9)
  assert.equal(estimate.n, 4)
})
