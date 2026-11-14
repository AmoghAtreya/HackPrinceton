import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as settle } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { ClaudeGateway } from '../src/main/assistant/model.ts'
import { ScreenService } from '../src/main/screen/service.ts'
import { DecisionLog } from '../src/main/simplifier/decision-log.ts'
import { SimplificationEngine } from '../src/main/simplifier/engine.ts'
import { contextVector, FEATURE_DIM, FEATURE_NAMES, FEATURE_VERSION, policyStateKey } from '../src/main/simplifier/features.ts'
import { evaluateOffPolicy } from '../src/main/simplifier/off-policy.ts'
import { RulesPolicy } from '../src/main/simplifier/policy.ts'
import { ThompsonPolicy } from '../src/main/simplifier/thompson.ts'
import { BKT_VERSION, LEARNING, MASTERED, OPPORTUNITY, levelOf, posterior, update } from '../src/main/skills/bkt.ts'
import { SkillStore } from '../src/main/skills/store.ts'
import { PAGE_SKILL, SkillTutor } from '../src/main/skills/tutor.ts'
import { catalogueOnly, isSkillId, prerequisitesOf, skill, skillIds, skills, type SkillId } from '../src/shared/skill-catalogue.ts'
import { routeSchema, type AssistantRoute } from '../src/shared/flight-contracts.ts'
import type { HighlightState } from '../src/shared/highlight-contracts.ts'
import type { DistilledPage } from '../src/shared/simplifier-contracts.ts'

const USER = 'local-user'
const near = (actual: number, expected: number, message?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} vs ${expected}`)
function tutorAt(clock = { now: 1_000_000 }) {
  const store = new SkillStore(':memory:')
  return { store, clock, tutor: new SkillTutor(store, () => clock.now) }
}
/** Enough clean, unaided successes that a skill is plainly known. */
function master(tutor: SkillTutor, ...ids: SkillId[]) { for (let round = 0; round < 6; round++) tutor.observe(USER, ids, 'unaided', true) }
const p = (store: SkillStore, id: SkillId) => store.states(USER).get(id)?.p ?? skill(id).prior

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test('the catalogue is fixed, well formed and has no prerequisite loops', () => {
  assert.equal(new Set(skillIds).size, skills.length)
  for (const item of skills) {
    assert.match(item.id, /^[a-z][a-z_]*$/)
    assert.ok(item.prior > 0 && item.prior < 1, item.id)
    for (const needed of item.requires) assert.ok(isSkillId(needed), `${item.id} needs unknown ${needed}`)
    // Every prerequisite comes before the things that need it, and nothing needs itself.
    const chain = prerequisitesOf(item.id)
    assert.equal(chain.includes(item.id), false)
    chain.forEach((id, index) => { for (const needed of skill(id).requires as SkillId[]) assert.ok(chain.indexOf(needed) < index, `${needed} before ${id}`) })
  }
  assert.deepEqual(prerequisitesOf('attach_photo'), ['click', 'scroll', 'find_button', 'read_email', 'type_text', 'send_email', 'pick_file'])
  assert.deepEqual(prerequisitesOf('click'), [])
  for (const example of ['attach_photo', 'spot_fake_link', 'sign_in_medicare']) assert.ok(isSkillId(example))
})

test('the model can only pick from the catalogue: anything else it names is dropped', () => {
  assert.deepEqual(catalogueOnly(['attach_photo', 'hack_the_bank', 'ATTACH_PHOTO', '', null, 42, 'attach_photo', 'pick_file', '__proto__', 'toString']), ['attach_photo', 'pick_file'])
  assert.deepEqual(catalogueOnly(['click', 'scroll', 'type_text', 'find_button']), ['click', 'scroll', 'type_text'], 'at most three')
  assert.equal(routeSchema.safeParse({ kind: 'how_to', skills: ['attach_photo'] }).success, true)
  assert.equal(routeSchema.safeParse({ kind: 'how_to', skills: ['attach_photo'], newSkill: { id: 'x' } }).success, false)
  const { tutor, store } = tutorAt()
  assert.equal(tutor.plan(USER, ['make_tea', 'be_trusted']), undefined)
  assert.deepEqual(tutor.asked(USER, 'c', ['make_tea']), [])
  tutor.observe(USER, ['make_tea' as SkillId], 'unaided', true)
  assert.equal(store.evidence(USER).length, 0, 'an invented skill leaves no trace')
  assert.throws(() => tutor.setPractice(USER, { id: 'make_tea', practice: true }), /not on Triage’s list/)
  tutor.dispose()
})

// ---------------------------------------------------------------------------
// Bayesian Knowledge Tracing
// ---------------------------------------------------------------------------

test('the update is the BKT posterior followed by the learning step', () => {
  // Unaided, right: 0.3*0.9 / (0.3*0.9 + 0.7*0.15) = 0.72, then 0.72 + 0.28*0.1.
  near(posterior(0.3, true, OPPORTUNITY.unaided), 0.72)
  near(update(0.3, true, 'unaided'), 0.748)
  // Unaided, wrong: 0.3*0.1 / (0.3*0.1 + 0.7*0.85) = 0.048, then 0.048 + 0.952*0.1.
  near(posterior(0.3, false, OPPORTUNITY.unaided), 0.048)
  near(update(0.3, false, 'unaided'), 0.1432)
  // Asking how: 0.6*0.15 / (0.6*0.15 + 0.4*0.7) = 0.09/0.37.
  near(posterior(0.6, false, OPPORTUNITY.asked), 0.09 / 0.37)
  // Implied by a harder success: evidence only, no learning step.
  near(update(0.4, true, 'implied'), (0.4 * 0.95) / (0.4 * 0.95 + 0.6 * 0.5))
})

test('stronger evidence moves the estimate further, and it always stays a probability', () => {
  for (const start of [0.05, 0.3, 0.5, 0.8]) {
    assert.ok(update(start, true, 'unaided') > update(start, true, 'pointed'), 'doing it alone proves more than clicking what was pointed at')
    assert.ok(update(start, true, 'pointed') > start)
    assert.ok(posterior(start, false, OPPORTUNITY.pointed) < start)
    assert.ok(posterior(start, false, OPPORTUNITY.asked) < start)
  }
  let estimate = 0.15
  let steps = 0
  while (estimate < MASTERED) { estimate = update(estimate, true, 'unaided'); steps++ }
  assert.ok(steps >= 2 && steps <= 4, `a few clean successes reach "known", not one: ${steps}`)
  for (let i = 0; i < 50; i++) estimate = update(estimate, true, 'unaided')
  assert.ok(estimate < 1)
  for (let i = 0; i < 50; i++) estimate = update(estimate, false, 'unaided')
  assert.ok(estimate > 0)
  for (const bad of [Number.NaN, -1, 2, Number.POSITIVE_INFINITY]) { const value = update(bad, true, 'pointed'); assert.ok(value > 0 && value < 1) }
  assert.deepEqual([0.9, MASTERED, 0.6, LEARNING, 0.2].map(levelOf), ['known', 'known', 'learning', 'learning', 'new'])
})

// ---------------------------------------------------------------------------
// Evidence from what the person does
// ---------------------------------------------------------------------------

test('asking lowers a skill, a first-try click raises it, and a real success also counts for what it builds on', () => {
  const { tutor, store } = tutorAt()
  const before = p(store, 'attach_photo')
  tutor.asked(USER, 'conversation', ['attach_photo'])
  const afterAsking = p(store, 'attach_photo')
  assert.ok(afterAsking < before)
  assert.equal(store.states(USER).has('send_email'), false, 'asking about one thing says nothing about its prerequisites')

  tutor.observe(USER, ['attach_photo'], 'pointed', true)
  assert.ok(p(store, 'attach_photo') > afterAsking)
  for (const needed of prerequisitesOf('attach_photo')) assert.ok(p(store, needed) > skill(needed).prior, needed)
  assert.equal(store.states(USER).has('spot_fake_link'), false, 'unrelated skills are untouched')

  const stuckFrom = p(store, 'sign_in')
  tutor.observe(USER, ['sign_in'], 'unaided', false)
  assert.ok(p(store, 'sign_in') < stuckFrom)
  assert.equal(p(store, 'fill_form'), skill('fill_form').prior, 'getting stuck does not count against the prerequisites')
  tutor.dispose()
})

test('the evidence log holds a skill, a kind of chance and an outcome: nothing about what was asked or seen', () => {
  const { tutor, store } = tutorAt()
  tutor.asked(USER, 'conversation', ['spot_fake_link'])
  const [row] = store.evidence(USER)
  assert.deepEqual(Object.keys(row).sort(), ['after', 'before', 'correct', 'createdAt', 'modelVersion', 'opportunity', 'skillId', 'userId'])
  assert.deepEqual([row.skillId, row.opportunity, row.correct, row.modelVersion], ['spot_fake_link', 'asked', false, BKT_VERSION])
  near(row.after, update(row.before, false, 'asked'))
  const columns = (table: string) => ((store as unknown as { db: DatabaseSync }).db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
  assert.deepEqual(columns('evidence'), ['seq', 'user_id', 'skill_id', 'opportunity', 'correct', 'p_before', 'p_after', 'model_version', 'created_at'])
  assert.deepEqual(columns('knowledge'), ['user_id', 'skill_id', 'p', 'opportunities', 'practice', 'updated_at'])
  tutor.dispose()
})

test('pointing: a first-try click counts for, a lost or abandoned highlight counts against', () => {
  const { tutor, store, clock } = tutorAt()
  tutor.asked(USER, 'chat-1', ['sign_in_medicare'])
  tutor.pointed(USER, 'chat-1', 'task-1')
  tutor.resolved('task-1', true)
  let rows = store.evidence(USER).filter((row) => row.opportunity === 'pointed')
  assert.deepEqual(rows.map((row) => [row.skillId, row.correct]).sort(), [['find_button', true], ['sign_in_medicare', true]])
  tutor.resolved('task-1', true)
  assert.equal(store.evidence(USER).filter((row) => row.opportunity === 'pointed').length, 2, 'one highlight is one chance')
  tutor.resolved('someone-elses-highlight', true)

  // Asking where again before clicking the last one: the last one did not work.
  tutor.pointed(USER, 'chat-1', 'task-2')
  tutor.pointed(USER, 'chat-1', 'task-3')
  rows = store.evidence(USER).filter((row) => row.opportunity === 'pointed' && !row.correct)
  assert.deepEqual(rows.map((row) => row.skillId).sort(), ['find_button', 'sign_in_medicare'])
  tutor.resolved('task-3', false)
  assert.equal(store.evidence(USER).filter((row) => row.opportunity === 'pointed' && !row.correct).length, 4)

  // Ten minutes later the how-to question is no longer what they are working on.
  clock.now += 10 * 60 * 1000 + 1
  tutor.pointed(USER, 'chat-1', 'task-4')
  tutor.resolved('task-4', true)
  assert.deepEqual(store.evidence(USER, 1).map((row) => row.skillId).concat(store.evidence(USER, 3).filter((row) => row.opportunity === 'pointed').map((row) => row.skillId)).includes('sign_in_medicare'), false)
  tutor.dispose()
})

test('simplified pages feed the skill their page type calls for', () => {
  assert.deepEqual(PAGE_SKILL, { login: 'sign_in', checkout: 'pay_online', form: 'fill_form', email: 'read_email', article: 'scroll', other: 'find_button' })
  const { tutor, store } = tutorAt()
  tutor.observePage(USER, 'login', { taskCompleted: true, backtracks: 0, repeatRequests: 0 })
  assert.deepEqual(store.evidence(USER).filter((row) => row.opportunity !== 'implied').map((row) => [row.skillId, row.opportunity, row.correct]), [['sign_in', 'pointed', true]])
  tutor.observePage(USER, 'checkout', { taskCompleted: false, backtracks: 2, repeatRequests: 0 })
  assert.deepEqual(store.evidence(USER, 1).map((row) => [row.skillId, row.opportunity, row.correct]), [['pay_online', 'unaided', false]])
  const count = store.evidence(USER).length
  tutor.observePage(USER, 'article', { taskCompleted: false, backtracks: 0, repeatRequests: 0 })
  assert.equal(store.evidence(USER).length, count, 'nothing observed, nothing recorded')
  tutor.dispose()
})

// ---------------------------------------------------------------------------
// Teaching: explain the gaps, skip what is known
// ---------------------------------------------------------------------------

test('a newcomer gets the missing steps in prerequisite order; someone who knows the basics gets only the gap', () => {
  const { tutor } = tutorAt()
  const fresh = tutor.plan(USER, ['attach_photo'])!
  assert.deepEqual(fresh.explain, ['read_email', 'send_email', 'pick_file', 'attach_photo'], 'at most four steps, the ones nearest the goal, goal last')
  // The basics get a few words; so does a gap the four-step limit pushed out.
  assert.deepEqual(fresh.remind, ['click', 'scroll', 'find_button', 'type_text'])
  assert.deepEqual(fresh.known, [])

  master(tutor, 'send_email')
  const later = tutor.plan(USER, ['attach_photo'])!
  assert.deepEqual(later.explain, ['pick_file', 'attach_photo'])
  assert.deepEqual(later.known, ['click', 'scroll', 'find_button', 'read_email', 'type_text', 'send_email'])
  assert.deepEqual(later.remind, [])

  master(tutor, 'attach_photo')
  assert.deepEqual(tutor.plan(USER, ['attach_photo'])!.explain, ['attach_photo'], 'what was asked is always answered')
  assert.deepEqual(tutor.plan(USER, ['attach_photo', 'spot_fake_link', 'nonsense'])!.targets, ['attach_photo', 'spot_fake_link'])
  tutor.dispose()
})

test('a caregiver’s practice mark makes Triage walk through a skill even when it is known', () => {
  const { tutor, store } = tutorAt()
  master(tutor, 'attach_photo')
  const estimate = p(store, 'send_email')
  tutor.setPractice(USER, { id: 'send_email', practice: true })
  const plan = tutor.plan(USER, ['attach_photo'])!
  assert.deepEqual(plan.explain, ['send_email', 'attach_photo'])
  assert.deepEqual(plan.practice, ['send_email'])
  assert.equal(p(store, 'send_email'), estimate, 'the mark changes what is explained, not the estimate')
  assert.match(tutor.guidance(USER, ['attach_photo'])!, /A caregiver asked for extra practice on: write and send an email\./)
  tutor.setPractice(USER, { id: 'send_email', practice: false })
  assert.deepEqual(tutor.plan(USER, ['attach_photo'])!.explain, ['attach_photo'])
  // Marking something never seen keeps it "new" and does not invent evidence.
  tutor.setPractice(USER, { id: 'spot_fake_link', practice: true })
  assert.equal(store.evidence(USER).some((row) => row.skillId === 'spot_fake_link'), false)
  tutor.dispose()
})

test('guidance and the view are words only: no score ever reaches the model or the screen', () => {
  const { tutor } = tutorAt()
  master(tutor, 'send_email')
  tutor.asked(USER, 'c', ['spot_fake_link'])
  const guidance = tutor.guidance(USER, ['attach_photo'])!
  assert.match(guidance, /^<teaching_plan>\n/)
  assert.match(guidance, /\n<\/teaching_plan>$/)
  assert.match(guidance, /They already do these comfortably, so leave them out: click with the mouse or trackpad; .*write and send an email\./)
  assert.match(guidance, /Explain these, in this order, one short step at a time: choose a file or photo from the computer; attach a photo to an email\./)
  assert.match(guidance, /never give a score/)
  for (const text of [guidance, tutor.locateGuidance(USER, 'c')]) assert.doesNotMatch(text, /\d|percent|%|probab|mastered/i)

  const view = tutor.view(USER)
  assert.equal(view.skills.length, skills.length)
  assert.deepEqual(Object.keys(view.skills[0]).sort(), ['id', 'name', 'practice', 'standing'])
  assert.doesNotMatch(JSON.stringify(view), /\d/, 'not a single digit crosses to the renderer')
  const standing = Object.fromEntries(view.skills.map((item) => [item.id, item.standing]))
  assert.equal(standing.send_email, 'known')
  assert.equal(standing.spot_fake_link, 'new')
  assert.equal(standing.pay_online, 'new', 'never seen: Triage claims nothing')
  assert.equal(standing.click, 'known', 'implied by the harder things they did')
  tutor.dispose()
})

test('how much is said when pointing depends on how used the person is to finding controls', () => {
  const { tutor } = tutorAt()
  assert.match(tutor.locateGuidance(USER, 'c'), /still learning to find controls.*say where it is/s)
  master(tutor, 'find_button')
  assert.match(tutor.locateGuidance(USER, 'c'), /one short sentence/)
  tutor.setPractice(USER, { id: 'find_button', practice: true })
  assert.match(tutor.locateGuidance(USER, 'c'), /say where it is/)
  tutor.dispose()
})

// ---------------------------------------------------------------------------
// Through the coordinator
// ---------------------------------------------------------------------------

interface Seen { kind: 'route' | 'reply' | 'locate'; trusted?: string }
async function fixture(routes: AssistantRoute[]) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-skills-'))
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, { available: async () => false, encrypt: async () => Buffer.alloc(0), decrypt: async () => ({ result: '', shouldReEncrypt: false }) })
  await credentials.connect('fixture-key-not-real', false, [{ id: 'claude-test', label: 'Fixture' }])
  const { tutor, store } = tutorAt()
  const seen: Seen[] = []
  const listeners: { clicked?: (state: HighlightState) => void; lost?: (state: HighlightState) => void } = {}
  const bounds = { x: 0, y: 0, width: 100, height: 50 }
  const screens = new ScreenService({ permission: () => 'granted', capture: async () => ({ data: 'eA==', mediaType: 'image/jpeg' as const,
    metadata: { displayId: 'd', displayName: 'D', width: 100, height: 50, bounds, cursor: { x: 1, y: 1 }, redactedRegions: 0 } }) })
  // A stand-in for the highlight controller: it "shows" every plan and lets the test click or lose it.
  const highlights = {
    revision: 0, snapshot: () => null, clear() {}, onChange: () => () => {},
    onClicked: (listener: (state: HighlightState) => void) => { listeners.clicked = listener; return () => {} },
    onLost: (listener: (state: HighlightState) => void) => { listeners.lost = listener; return () => {} },
    plan: (_reply: unknown, capture: unknown, taskId: string) => ({ revision: 0, capture, state: { id: 'h-' + taskId, taskId } }),
    present: () => true
  }
  const coordinator = new AssistantCoordinator({
    history, credentials, screens, changed: () => {}, tutor, highlights: highlights as never,
    gateway: {
      models: async () => [],
      route: async () => { seen.push({ kind: 'route' }); return routes.shift() ?? { kind: 'reply', text: 'Okay.' } },
      reply: async (_k, _m, _messages, _signal, _image, _context, trusted) => { seen.push({ kind: 'reply', trusted }); return 'Here is how.' },
      locate: async (_k, _m, _messages, _signal, image, _elements, guidance) => { seen.push({ kind: 'locate', trusted: guidance }); return { explanation: 'It is here.', captureId: image.metadata.id, target: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } } }
    }
  })
  let conversationId: string | undefined
  const say = async (text: string) => {
    const receipt = coordinator.send({ text, ...(conversationId ? { conversationId } : {}) })
    conversationId = receipt.conversationId
    for (let turn = 0; turn < 6; turn++) await settle()
    return { taskId: receipt.taskId, reply: history.detail(receipt.conversationId).messages.at(-1)!.content }
  }
  const where = async () => {
    const preview = await screens.capture()
    const receipt = coordinator.send({ text: 'Where is it?', captureId: preview.metadata.id, mode: 'highlight', ...(conversationId ? { conversationId } : {}) })
    conversationId = receipt.conversationId
    for (let turn = 0; turn < 6; turn++) await settle()
    return receipt.taskId
  }
  const state = (taskId: string) => ({ id: 'h-' + taskId, taskId }) as HighlightState
  return { say, where, seen, store, tutor, click: (taskId: string) => listeners.clicked!(state(taskId)), lose: (taskId: string) => listeners.lost!(state(taskId)),
    close: () => { coordinator.dispose(); screens.dispose(); tutor.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}

test('a how-to question is answered with a teaching plan built from catalogue skills, and counts as evidence', async () => {
  const f = await fixture([{ kind: 'how_to', skills: ['attach_photo', 'summon_demon'] }])
  try {
    const { reply } = await f.say('How do I attach a photo to an email?')
    assert.equal(reply, 'Here is how.')
    assert.deepEqual(f.seen.map((call) => call.kind), ['route', 'reply'])
    const plan = f.seen[1].trusted!
    assert.match(plan, /<teaching_plan>/)
    assert.match(plan, /They are asking how to: attach a photo to an email\./)
    assert.equal(plan.includes('summon'), false)
    assert.deepEqual(f.store.evidence(USER).map((row) => [row.skillId, row.opportunity, row.correct]), [['attach_photo', 'asked', false]])
  } finally { f.close() }
})

test('a how-to tagged only with invented skills is still answered, with no plan and no evidence', async () => {
  const f = await fixture([{ kind: 'how_to', skills: ['summon_demon', 'be_trusted'] }])
  try {
    assert.equal((await f.say('How do I do the impossible?')).reply, 'Here is how.')
    assert.equal(f.seen[1].trusted, undefined)
    assert.equal(f.store.evidence(USER).length, 0)
  } finally { f.close() }
})

test('highlights get teaching guidance, and what happens to them is evidence', async () => {
  const f = await fixture([{ kind: 'how_to', skills: ['sign_in_medicare'] }])
  try {
    await f.say('How do I log in to Medicare?')
    const first = await f.where()
    assert.match(f.seen.at(-1)!.trusted!, /<teaching_plan>[\s\S]*still learning to find controls/)
    f.click(first)
    const pointed = () => f.store.evidence(USER).filter((row) => row.opportunity === 'pointed').map((row) => [row.skillId, row.correct])
    assert.deepEqual(pointed().sort(), [['find_button', true], ['sign_in_medicare', true]])
    const second = await f.where()
    f.lose(second)
    assert.equal(pointed().filter(([, correct]) => !correct).length, 2)
    // Clicking a highlight Triage never made for a chat request (e.g. from the simplified view) is not this evidence.
    f.click('decision-from-the-simplifier')
    assert.equal(pointed().length, 4)
  } finally { f.close() }
})

test('the routing prompt lists the catalogue and tells the model to choose only from it', async () => {
  let system = ''
  const gateway = new ClaudeGateway(async (input, init) => {
    system = (await new Request(input, init).json()).system
    return Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: '{"kind":"how_to","skills":["attach_photo"]}' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
  })
  assert.deepEqual(await gateway.route('fake-test-key', 'claude-test', [{ role: 'user', content: 'How do I attach a photo?' }], new AbortController().signal), { kind: 'how_to', skills: ['attach_photo'] })
  for (const item of skills) assert.ok(system.includes(`- ${item.id}: ${item.name}`), item.id)
  assert.match(system, /Choose only from this list and copy ids exactly; if none fits, return an empty list\. Never invent an id\./)
})

// ---------------------------------------------------------------------------
// The page simplifier's learner
// ---------------------------------------------------------------------------

const page: DistilledPage = {
  url: 'https://bank.example.com/login', title: 'Sign in', lang: 'en', mainText: 'Sign in.', capturedAt: 0,
  elements: [{ id: 'e0', kind: 'input', label: 'Password', region: 'main', inputType: 'password', area: 0.01, top: 0.2 }, { id: 'e1', kind: 'button', label: 'Sign in', region: 'main', area: 0.01, top: 0.3 }],
  stats: { totalElements: 20, interactiveElements: 2, maxNavDepth: 0, textLength: 8, hiddenRemoved: 0 }
}
const session = { userId: USER, now: Date.UTC(2026, 10, 14, 15), voiceEnabled: false, recentErrorRate: 0 }

test('the learner’s context carries per-skill knowledge where the generic traits used to be', () => {
  assert.equal(FEATURE_VERSION, 2)
  assert.deepEqual(FEATURE_NAMES.slice(14), ['skill_page', 'skill_weakest_prerequisite', 'skill_overall', 'skill_practice'])
  assert.equal(FEATURE_NAMES.some((name) => name.startsWith('trait_')), false)
  const { tutor } = tutorAt()
  const newcomer = tutor.features(USER, 'login')
  assert.deepEqual([newcomer.page, newcomer.practice], [skill('sign_in').prior, 0])
  assert.equal(newcomer.weakestPrerequisite, Math.min(...prerequisitesOf('sign_in').map((id) => skill(id).prior)))
  master(tutor, 'sign_in')
  tutor.setPractice(USER, { id: 'sign_in', practice: true })
  const practised = tutor.features(USER, 'login')
  assert.ok(practised.page >= MASTERED && practised.overall > newcomer.overall && practised.practice === 1)
  assert.deepEqual(tutor.features(USER, 'checkout').practice, 0, 'a different page type, a different skill')
  const x = contextVector(page, 'login', session, practised)
  assert.equal(x.length, FEATURE_DIM)
  assert.deepEqual(x.slice(14), [practised.page, practised.weakestPrerequisite, practised.overall, 1])

  // The rules baseline now reads those entries.
  const rules = new RulesPolicy()
  const choose = (knowledge: Parameters<typeof contextVector>[3]) =>
    rules.choose({ userId: USER, x: contextVector(page, 'login', session, knowledge), arms: [...new Set(['a04', 'a05', 'a06'])].map((id) => ({ id } as never)), pageType: 'login', sensitive: true }).armId
  assert.equal(choose({ page: 0.2, weakestPrerequisite: 0.2, overall: 0.3, practice: 0 }), 'a05', 'new to it: plain words, step by step')
  assert.equal(choose({ page: 0.95, weakestPrerequisite: 0.9, overall: 0.8, practice: 0 }), 'a04', 'fluent: the page’s own wording')
  assert.equal(choose({ page: 0.95, weakestPrerequisite: 0.9, overall: 0.8, practice: 1 }), 'a05', 'marked for practice: step by step again')
  assert.equal(choose({ page: 0.6, weakestPrerequisite: 0.6, overall: 0.5, practice: 0 }), 'a06')
  tutor.dispose()
})

test('the engine logs decisions under the new version using the tutor’s knowledge', async () => {
  const { tutor } = tutorAt()
  master(tutor, 'sign_in')
  const log = new DecisionLog(':memory:')
  const engine = new SimplificationEngine({ log, policy: new RulesPolicy(), now: () => session.now, knowledge: (userId, pageType) => tutor.features(userId, pageType) })
  const result = await engine.simplify({ page, userId: USER, voiceEnabled: false })
  const logged = log.get(result.decisionId)!
  assert.equal(logged.featureVersion, 2)
  assert.equal(logged.policyVersion, 2)
  assert.deepEqual(logged.x.slice(14), Object.values(tutor.features(USER, 'login')))
  assert.equal(result.arm.id, 'a04')
  // With no tutor the learner sees neutral knowledge rather than failing.
  const plain = new SimplificationEngine({ log, policy: new RulesPolicy(), now: () => session.now })
  assert.deepEqual(log.get((await plain.simplify({ page, userId: USER, voiceEnabled: false })).decisionId)!.x.slice(14), [0.5, 0.5, 0.5, 0])
  log.close(); tutor.dispose()
})

test('old learning logs stay valid and are never mixed with the new format', async () => {
  const log = new DecisionLog(':memory:')
  // A decision and a saved bandit from before this change: feature version 1, traits in entries 14..17.
  const oldX = [1, 0, 0, 0, 1, 0, 0, 0.2, 0, 0.1, 0.5, 0.5, 0, 0, 0.9, 0.5, 0.5, 0.5]
  const oldState = JSON.stringify({ name: 'thompson', version: 1, featureVersion: 1, dim: 18, population: { a08: { marker: 'learned-under-v1' } }, users: {} })
  log.savePolicy('thompson', oldState, 1)
  const oldId = log.record({ userId: USER, episodeId: 'old-episode', step: 0, pageType: 'login', pageHost: 'bank.example.com', featureVersion: 1, x: oldX,
    armId: 'a08', propensity: 0.5, mode: 'explore', policyName: 'thompson', policyVersion: 1, viewSource: 'rules', sensitive: true, voiceEnabled: false }, 1)

  assert.equal(policyStateKey('thompson', 1), 'thompson')
  assert.equal(policyStateKey('thompson'), 'thompson@features-v2')
  // The new learner does not start from statistics learned under the old layout, even though the vector is the same length.
  const restored = new ThompsonPolicy({}, () => 0.5, oldState)
  assert.equal(restored.serialize().includes('learned-under-v1'), false)

  const learned: string[] = []
  const policy = new ThompsonPolicy({}, () => 0.5, log.loadPolicy(policyStateKey('thompson')))
  const learn = policy.learn.bind(policy)
  policy.learn = (input, armId, reward) => { learned.push(armId); learn(input, armId, reward) }
  const engine = new SimplificationEngine({ log, policy, now: () => session.now })
  const fresh = await engine.simplify({ page, userId: USER, voiceEnabled: false })
  const signals = { taskCompleted: true, durationMs: 20_000, backtracks: 0, thumbsUp: true, showedOriginal: false, repeatRequests: 0 }

  // Rating the old page still works and is still recorded...
  const oldReward = engine.reportOutcome(oldId, signals)
  assert.ok(typeof oldReward === 'number' && oldReward > 0)
  assert.equal(log.get(oldId)!.reward, oldReward)
  assert.deepEqual(log.get(oldId)!.x, oldX, 'its context vector is exactly as it was logged')
  assert.equal(log.get(oldId)!.featureVersion, 1)
  // ...but it does not train the new learner.
  assert.deepEqual(learned, [])
  engine.reportOutcome(fresh.decisionId, signals)
  assert.deepEqual(learned, [fresh.arm.id])

  // The old saved state is byte-for-byte untouched; the new one lives beside it.
  assert.equal(log.loadPolicy('thompson'), oldState)
  assert.equal(JSON.parse(log.loadPolicy('thompson@features-v2')!).featureVersion, 2)

  // Readers can ask for one format, and evaluation only ever uses the current one.
  assert.deepEqual(log.rewarded({ featureVersion: 1 }).map((decision) => decision.id), [oldId])
  assert.deepEqual(log.rewarded({ featureVersion: 2 }).map((decision) => decision.id), [fresh.decisionId])
  assert.equal(log.rewarded().length, 2)
  assert.deepEqual(log.episodes({ featureVersion: 1 }).map((episode) => episode.map((decision) => decision.id)), [[oldId]])
  assert.equal(evaluateOffPolicy(new RulesPolicy(), log.rewarded()).n, 1)
  log.close()
})
