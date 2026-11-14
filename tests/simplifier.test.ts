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

// ---- Bandit tests -----------------------------------------------------------
// Thompson Sampling is random by design, so these tests avoid depending on one
// lucky random sequence:
//   1. Learning maths is tested with NO sampling (sensitive pages act greedily
//      on the posterior mean, which is fully deterministic given the data).
//   2. Exploration behaviour is tested across many seeds with a pass-rate
//      threshold, so a single unlucky seed cannot fail the build.
//   3. Freezing uses tiny thresholds so it triggers in a handful of steps.
// None of them read the wall clock: `now` is a fixed timestamp.

const FIXED_NOW = Date.UTC(2026, 10, 13, 15, 0, 0)
function banditInput(userId = 'u', sensitive = false) {
  const p = page([el(0, {})], { mainText: 'x'.repeat(2000) })
  const knowledge = { page: 0.9, weakestPrerequisite: 0.5, overall: 0.5, practice: 0 }
  const x = contextVector(p, 'article', { userId, now: FIXED_NOW, voiceEnabled: false, recentErrorRate: 0 }, knowledge)
  return { userId, x, arms: allowedArms(false), pageType: 'article' as const, sensitive }
}

test('bandit posterior learns the best arm from fixed data (no sampling involved)', () => {
  const policy = new ThompsonPolicy({}, () => { throw new Error('random must not be used') })
  const input = banditInput('u', true)
  assert.equal(input.x.length, FEATURE_DIM)
  // Same data every run: every arm tried 10 times, a08 is clearly better.
  for (let i = 0; i < 10; i++) for (const arm of input.arms) policy.learn(input, arm.id, arm.id === 'a08' ? 0.9 : 0.3)
  const decision = policy.choose(input)
  assert.deepEqual(decision, { armId: 'a08', propensity: 1, mode: 'shielded' })
  assert.equal(policy.probability(input, 'a08'), 1)
  // Learning survives a save/restore round trip.
  const restored = new ThompsonPolicy({}, () => { throw new Error('random must not be used') }, policy.serialize())
  assert.equal(restored.choose(input).armId, 'a08')
})

test('new users start from the population model (cold start)', () => {
  const policy = new ThompsonPolicy({}, () => { throw new Error('random must not be used') })
  const veteran = banditInput('veteran', true)
  for (let i = 0; i < 20; i++) for (const arm of veteran.arms) policy.learn(veteran, arm.id, arm.id === 'a09' ? 0.95 : 0.2)
  assert.equal(policy.choose(banditInput('newcomer', true)).armId, 'a09')
})

test('a brand-new user gets the default layout, not a random one', () => {
  const policy = new ThompsonPolicy({}, () => { throw new Error('random must not be used during warmup') })
  assert.deepEqual(policy.choose(banditInput('first-timer')), { armId: 'a06', propensity: 1, mode: 'exploit' })
})

test('exploration finds the best arm for at least 9 of 10 random seeds', () => {
  let converged = 0
  for (let seed = 1; seed <= 10; seed++) {
    const policy = new ThompsonPolicy({ freezeAfter: 1e9, propensitySamples: 20 }, seededRandom(seed))
    const input = banditInput()
    for (let i = 0; i < 150; i++) {
      const { armId } = policy.choose(input)
      policy.learn(input, armId, armId === 'a08' ? 0.9 : 0.3)
    }
    if (policy.choose({ ...input, sensitive: true }).armId === 'a08') converged++
  }
  assert.ok(converged >= 9, `only ${converged}/10 seeds converged`)
})

test('logged propensities are always valid probabilities', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const policy = new ThompsonPolicy({ propensitySamples: 20 }, seededRandom(seed))
    const input = banditInput()
    for (let i = 0; i < 20; i++) {
      const decision = policy.choose(input)
      assert.ok(decision.propensity > 0 && decision.propensity <= 1)
      assert.ok(input.arms.some((arm) => arm.id === decision.armId))
      policy.learn(input, decision.armId, 0.5)
    }
  }
})

test('layout freezes once confident and can be unfrozen', () => {
  const policy = new ThompsonPolicy({ freezeAfter: 5, freezeConfidence: 0.5, propensitySamples: 20 }, seededRandom(3))
  const input = banditInput()
  for (let i = 0; i < 10; i++) for (const arm of input.arms) policy.learn(input, arm.id, arm.id === 'a08' ? 0.95 : 0.1)
  policy.choose(input)
  assert.equal(policy.frozenArms('u').article, 'a08')
  assert.deepEqual(policy.choose(input), { armId: 'a08', propensity: 1, mode: 'frozen' })
  policy.unfreeze('u', 'article')
  assert.equal(policy.frozenArms('u').article, undefined)
})

test('a slow LLM falls back to the rules view without waiting for a real timeout', async () => {
  const log = new DecisionLog(':memory:')
  const deadline = new AbortController()
  const hanging = { simplify: (request: { signal: AbortSignal }) => new Promise<never>((_, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })
  }) }
  const engine = new SimplificationEngine({ log, policy: new RulesPolicy(), model: hanging, now: () => FIXED_NOW, timeoutSignal: () => deadline.signal })
  const pending = engine.simplify({ page: page([el(0, { label: 'Continue' })]), userId: 'u', voiceEnabled: false, credentials: { key: 'k', model: 'm' } })
  deadline.abort() // "20 seconds pass" instantly.
  assert.equal((await pending).view.source, 'rules')
  log.close()
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

test('a History tab rating becomes one reward and shows up in the learning summary', async () => {
  const { SimplifierService } = await import('../src/main/simplifier/service.ts')
  const log = new DecisionLog(':memory:')
  const engine = new SimplificationEngine({ log, policy: new RulesPolicy(), now: () => FIXED_NOW })
  const service = new SimplifierService({ engine, log, presenter: { show() {} }, channel: 'chrome', demoHtml: '', now: () => FIXED_NOW })
  const result = await engine.simplify({ page: page([el(0, { label: 'Continue' })]), userId: 'local-user', voiceEnabled: false })
  const before = service.learning('local-user')
  assert.equal(before.entries[0].reward, null)
  assert.equal(before.rated, 0)
  const after = service.rate('local-user', result.decisionId, true)
  assert.equal(after.rated, 1)
  assert.ok(after.entries[0].reward! > 0.5)
  assert.throws(() => service.rate('local-user', result.decisionId, false), /already rated/)
  assert.throws(() => service.rate('someone-else', result.decisionId, true), /no longer/)
  log.close()
})

test('/simplify targets the open tab, an address, or (as /examplesimplify) the example page', async () => {
  const { parseSimplifyCommand } = await import('../src/main/simplifier/service.ts')
  assert.deepEqual(parseSimplifyCommand('/simplify'), { kind: 'current' })
  assert.deepEqual(parseSimplifyCommand('  /SIMPLIFY  '), { kind: 'current' })
  assert.deepEqual(parseSimplifyCommand('/simplify example.com'), { kind: 'url', url: 'https://example.com/' })
  assert.deepEqual(parseSimplifyCommand('/examplesimplify'), { kind: 'demo' })
  assert.deepEqual(parseSimplifyCommand('/simplify demo'), { kind: 'demo' })
  assert.equal(parseSimplifyCommand('/simplifyx'), null)
  assert.equal(parseSimplifyCommand('/examplesimplify example.com'), null)
  assert.equal(parseSimplifyCommand('please simplify this'), null)
  assert.throws(() => parseSimplifyCommand('/simplify ftp://example.com'), /Only http and https/)
})

test('the current-tab reader takes the first web address and skips Triage’s own page when it can', async () => {
  const { currentTabReader, webUrl } = await import('../src/main/simplifier/current-tab.ts')
  assert.equal(webUrl('https://shop.example/orders#top'), 'https://shop.example/orders')
  assert.equal(webUrl('chrome://newtab/'), undefined)
  assert.equal(webUrl('not a url'), undefined)
  const failing = async () => { throw new Error('no access') }
  const reader = currentTabReader([failing, async () => 'chrome://settings', async () => 'https://a.example/x', async () => 'https://b.example/'])
  assert.equal(await reader(), 'https://a.example/x')
  // Triage's own browser is showing a.example: the next source's different page wins.
  assert.equal(await reader('https://a.example/x'), 'https://b.example/')
  // Only Triage's own page is offered: it is the same page either way, so use it.
  assert.equal(await currentTabReader([async () => 'https://a.example/x'])('https://a.example/x'), 'https://a.example/x')
  assert.equal(await currentTabReader([async () => undefined])(), undefined)
})
