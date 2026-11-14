import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DistilledPage, PageElement, SimplifiedViewDraft } from '../src/shared/simplifier-contracts.ts'
import { RiskTier } from '../src/shared/simplifier-contracts.ts'
import { allowedArms, armById } from '../src/main/simplifier/arms.ts'
import { classifyPage, riskTier, rankElements } from '../src/main/simplifier/classify.ts'
import { DecisionLog } from '../src/main/simplifier/decision-log.ts'
import { SimplificationEngine } from '../src/main/simplifier/engine.ts'
import { contextVector, FEATURE_DIM } from '../src/main/simplifier/features.ts'
import { seededRandom } from '../src/main/simplifier/linalg.ts'
import { evaluateOffPolicy } from '../src/main/simplifier/off-policy.ts'
import { RulesPolicy } from '../src/main/simplifier/policy.ts'
import { computeReward } from '../src/main/simplifier/reward.ts'
import { ThompsonPolicy } from '../src/main/simplifier/thompson.ts'
import { finalizeView } from '../src/main/simplifier/view.ts'

function el(id: number, partial: Partial<PageElement>): PageElement {
  return { id: 'e' + id, kind: 'button', label: 'Button', region: 'main', area: 0.01, top: 0.2, ...partial }
}
function page(elements: PageElement[], extra: Partial<DistilledPage> = {}): DistilledPage {
  return {
    url: 'https://example.com/page', title: 'Example', lang: 'en', elements, mainText: 'Some text.',
    stats: { totalElements: 200, interactiveElements: elements.length, maxNavDepth: 2, textLength: 500, hiddenRemoved: 0 },
    capturedAt: 0, ...extra
  }
}
const signals = { taskCompleted: true, durationMs: 30000, backtracks: 0, thumbsUp: null, showedOriginal: false, repeatRequests: 0 }

test('classification and risk tiers come from rules', () => {
  const login = page([el(0, { kind: 'input', inputType: 'password', label: 'Password' }), el(1, { label: 'Sign in' })])
  assert.equal(classifyPage(login), 'login')
  assert.equal(riskTier(login.elements[0], login), RiskTier.MoneyOrCredentials)
  assert.equal(riskTier(login.elements[1], login), RiskTier.MoneyOrCredentials)
  const shop = page([el(0, { label: 'Pay now' })])
  assert.equal(classifyPage(shop), 'checkout')
  const news = page([el(0, { kind: 'link', label: 'Read more' })], { mainText: 'x'.repeat(2000) })
  assert.equal(classifyPage(news), 'article')
  assert.equal(riskTier(news.elements[0], news), RiskTier.Navigate)
})

test('ranking demotes footer and cookie noise', () => {
  const p = page([el(0, { region: 'footer', label: 'Privacy policy' }), el(1, { label: 'Refill prescription' }), el(2, { label: 'Accept cookies', region: 'dialog' })])
  assert.equal(rankElements(p)[0].id, 'e1')
})

test('reward follows the documented formula and stays in [0, 1]', () => {
  assert.ok(Math.abs(computeReward(signals, 'other') - (0.5 + 0.2 * (1 - 30000 / 180000) + 0.15 + 0.075)) < 1e-9)
  assert.equal(computeReward({ ...signals, taskCompleted: false, durationMs: 1e9, backtracks: 5, thumbsUp: false, showedOriginal: true, repeatRequests: 9 }, 'other'), 0)
})

test('finalizeView drops invented IDs, enforces the arm budget and sets tiers', () => {
  const p = page([el(0, { label: 'Next' }), el(1, { label: 'Pay bill' }), el(2, { label: 'Help' }), el(3, { label: 'More' })])
  const draft: SimplifiedViewDraft = {
    title: 'T', purpose: 'P', summary: ['a'], narration: 'hello', concerns: [],
    actions: [{ elementId: 'e99', label: 'Fake', hint: '' }, { elementId: 'e1', label: 'Pay', hint: '' }, { elementId: 'e1', label: 'Dup', hint: '' },
      { elementId: 'e0', label: 'Next', hint: '' }, { elementId: 'e2', label: 'Help', hint: '' }, { elementId: 'e3', label: 'More', hint: '' }]
  }
  const view = finalizeView(draft, p, rankElements(p), armById('a06'))
  assert.deepEqual(view.actions.map((a) => a.elementId), ['e1', 'e0', 'e2'])
  assert.equal(view.actions[0].tier, RiskTier.MoneyOrCredentials)
  assert.equal(view.narration, '')
})

test('voice arms are shielded off when voice is disabled', () => {
  assert.ok(allowedArms(false).every((arm) => !arm.voiceNarration))
})

test('Thompson policy learns a persona preference and never explores on sensitive pages', () => {
  const policy = new ThompsonPolicy({ freezeAfter: 1e9, propensitySamples: 50 }, seededRandom(7))
  const p = page([el(0, {})], { mainText: 'x'.repeat(2000) })
  const traits = { visionSupport: 0.9, readingSupport: 0.5, voicePreference: 0.5, techConfidence: 0.5 }
  const x = contextVector(p, 'article', { userId: 'u', now: 0, voiceEnabled: false, recentErrorRate: 0 }, traits)
  assert.equal(x.length, FEATURE_DIM)
  const input = { userId: 'u', x, arms: allowedArms(false), pageType: 'article' as const, sensitive: false }
  for (let i = 0; i < 300; i++) {
    const { armId } = policy.choose(input)
    policy.learn(input, armId, armId === 'a08' ? 0.9 : 0.3)
  }
  assert.ok(policy.probability(input, 'a08') > 0.8)
  const sensitive = policy.choose({ ...input, sensitive: true })
  assert.equal(sensitive.mode, 'shielded')
  assert.equal(sensitive.propensity, 1)
  const restored = new ThompsonPolicy({ freezeAfter: 1e9 }, seededRandom(1), policy.serialize())
  assert.ok(restored.probability(input, 'a08') > 0.8)
})

test('engine falls back to rules, logs the decision and rewards it once', async () => {
  const log = new DecisionLog(':memory:')
  const failing = { simplify: async () => { throw new Error('model down') } }
  const engine = new SimplificationEngine({ log, policy: new RulesPolicy(), model: failing, now: () => 1000 })
  const p = page([el(0, { label: 'Continue' })])
  const result = await engine.simplify({ page: p, userId: 'u', voiceEnabled: false, credentials: { key: 'k', model: 'm' } })
  assert.equal(result.view.source, 'rules')
  assert.equal(log.get(result.decisionId)?.propensity, 1)
  assert.ok(engine.reportOutcome(result.decisionId, signals)! > 0)
  assert.equal(engine.reportOutcome(result.decisionId, signals), null)
  const estimate = evaluateOffPolicy(new RulesPolicy(), log.rewarded())
  assert.equal(estimate.n, 1)
  assert.equal(estimate.snips, estimate.logged)
  log.close()
})
