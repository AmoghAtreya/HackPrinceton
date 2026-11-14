import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as settle } from 'node:timers/promises'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { ClaudeGateway } from '../src/main/assistant/model.ts'
import { ContextService } from '../src/main/context/service.ts'
import { HighlightController } from '../src/main/screen/highlight.ts'
import { DecisionLog } from '../src/main/simplifier/decision-log.ts'
import { SimplificationEngine } from '../src/main/simplifier/engine.ts'
import { RulesPolicy } from '../src/main/simplifier/policy.ts'
import { PRESS_HINT } from '../src/main/simplifier/render.ts'
import { computeReward } from '../src/main/simplifier/reward.ts'
import { ScreenSimplifier, describeScreenResult } from '../src/main/simplifier/screen.ts'
import { SimplifierService } from '../src/main/simplifier/service.ts'
import type { AxSnapshot, ContextSnapshot } from '../src/shared/context-contracts.ts'
import { routeSchema, type AssistantRoute } from '../src/shared/flight-contracts.ts'
import type { FrameReading, Rectangle } from '../src/shared/highlight-contracts.ts'
import type { SimplifiedViewDraft } from '../src/shared/simplifier-contracts.ts'

const read = (name: string): AxSnapshot => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'))
const news = () => read('context-cluttered-news.json')
const login = () => read('context-login.json')
const USER = 'local-user'

/** Runs fixture JSON through the real ContextService, exactly as the native module's output would be. */
async function snapshotOf(raw: AxSnapshot): Promise<ContextSnapshot> {
  const service = new ContextService({ permission: () => 'granted', snapshot: () => JSON.stringify(raw), displayIdFor: () => 'display-1' })
  try { return await service.capture() } finally { service.dispose() }
}
function at(raw: AxSnapshot, url: string): AxSnapshot {
  const copy = structuredClone(raw)
  copy.url = url
  for (const element of copy.elements) if (element.role === 'AXWebArea') element.url = url
  return copy
}

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

test('simplify_page is a route with no arguments', () => {
  assert.deepEqual(routeSchema.parse({ kind: 'simplify_page' }), { kind: 'simplify_page' })
  for (const bad of [{ kind: 'simplify_page', url: 'https://example.com' }, { kind: 'simplify_page', elementId: 'e1' }, { kind: 'simplify' }])
    assert.equal(routeSchema.safeParse(bad).success, false, JSON.stringify(bad))
})

test('the route prompt offers simplify_page and the reply is parsed into the route', async () => {
  const gateway = new ClaudeGateway(async (input, init) => {
    const body = await new Request(input, init).json()
    assert.match(body.system, /\{"kind":"simplify_page"\}/)
    assert.match(body.system, /never clicks/)
    return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: '{"kind":"simplify_page"}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
  })
  assert.deepEqual(await gateway.route('fake-test-key', 'claude-test', [{ role: 'user', content: 'Simplify this page' }], new AbortController().signal), { kind: 'simplify_page' })
})

async function coordinatorFixture(route: AssistantRoute, screenSimplifier?: ConstructorParameters<typeof AssistantCoordinator>[0]['screenSimplifier']) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-simplify-'))
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, {
    available: async () => false, encrypt: async () => Buffer.alloc(0), decrypt: async () => ({ result: '', shouldReEncrypt: false })
  })
  await credentials.connect('fixture-key-not-real', false, [{ id: 'claude-test', label: 'Fixture' }])
  let routed = 0
  const coordinator = new AssistantCoordinator({
    history, credentials, changed: () => {}, screenSimplifier,
    gateway: { models: async () => [], reply: async () => 'Text reply', route: async () => { routed++; return route } }
  })
  return { coordinator, history, routed: () => routed, close: () => { coordinator.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}

test('the chat route and the menu entry both run the screen simplifier', async () => {
  const log = new DecisionLog(':memory:')
  const engine = new SimplificationEngine({ log, policy: new RulesPolicy() })
  const calls: Array<{ userId: string; credentials: unknown }> = []
  const page = await snapshotOf(news())
  const simplifier = new ScreenSimplifier({
    contexts: { capture: async () => page }, engine, presenter: { show() {} },
    highlights: new HighlightController({ display: () => undefined, draw() {}, hide() {} }), probe: async () => ({ frame: null, frontmost: true })
  })
  const f = await coordinatorFixture({ kind: 'simplify_page' }, {
    simplify: (userId, credentials, signal) => { calls.push({ userId, credentials }); return simplifier.simplify(userId, undefined, signal) },
    forget: (id) => simplifier.forget(id)
  })
  try {
    const chat = f.coordinator.send({ text: 'Can you simplify this page for me?' })
    await settle(); await settle()
    const first = f.history.detail(chat.conversationId)
    assert.equal(first.messages[1].status, 'completed')
    assert.match(first.messages[1].content, /^Simplified: Medicare Open Enrollment 2027/)
    assert.match(first.messages[1].content, /I never press anything for you/)
    assert.ok(first.activity.some((event) => event.type === 'page_simplified'))
    assert.deepEqual(calls, [{ userId: USER, credentials: { key: 'fixture-key-not-real', model: 'claude-test' } }])

    const menu = f.coordinator.simplifyPage()
    await settle(); await settle()
    assert.equal(f.routed(), 1, 'the menu entry does not ask the model to route')
    assert.equal(calls.length, 2)
    assert.match(f.history.detail(menu.conversationId).messages[1].content, /^Simplified: /)
  } finally { f.close(); log.close() }

  const without = await coordinatorFixture({ kind: 'simplify_page' })
  try {
    assert.throws(() => without.coordinator.simplifyPage(), /unavailable/)
    const receipt = without.coordinator.send({ text: 'Simplify this page' })
    await settle(); await settle()
    assert.equal(without.history.detail(receipt.conversationId).messages[0].status, 'failed')
  } finally { without.close() }
})

// ---------------------------------------------------------------------------
// Snapshot -> simplify -> view
// ---------------------------------------------------------------------------

interface Bench {
  simplifier: ScreenSimplifier
  engine: SimplificationEngine
  log: DecisionLog
  highlights: HighlightController
  clock: { now: number }
  shown: Array<{ html: string; title: string; focus: boolean }>
  drawn: Rectangle[]
  probes: Array<{ pid: number; path: number[] }>
  avoided: Rectangle[]
  closed: { count: number }
  reading: { value: FrameReading }
  clickTarget: () => void
  queue: ContextSnapshot[]
  close(): void
}
function bench(options: { draft?: SimplifiedViewDraft } = {}): Bench {
  const log = new DecisionLog(':memory:')
  const clock = { now: 1_000_000 }
  const model = options.draft ? { simplify: async () => options.draft! } : undefined
  const engine = new SimplificationEngine({ log, policy: new RulesPolicy(), model, now: () => clock.now })
  const shown: Bench['shown'] = []
  const drawn: Rectangle[] = []
  const probes: Bench['probes'] = []
  const avoided: Rectangle[] = []
  const closed = { count: 0 }
  const reading: Bench['reading'] = { value: { frame: null, frontmost: true } }
  const queue: ContextSnapshot[] = []
  let clicked = () => {}
  // This port is everything the flow can do to the screen: draw, hide, and watch for the person's own click.
  const highlights = new HighlightController({
    display: () => ({ bounds: { x: 0, y: 0, width: 1600, height: 1400 } }),
    draw: (state) => { drawn.push(state.rectangle) }, hide: () => {},
    observeClick: (_target, callback) => { clicked = callback; return () => {} },
    frameOf: async () => reading.value, every: () => () => {}, now: () => clock.now
  })
  const simplifier = new ScreenSimplifier({
    contexts: { capture: async () => queue.shift()! }, engine, highlights, now: () => clock.now,
    presenter: {
      show: (html, title, focus = true) => { shown.push({ html, title, focus }) },
      avoid: (target) => { avoided.push(target) }, close: () => { closed.count++; simplifier.viewClosed() }
    },
    probe: async (pid, path) => { probes.push({ pid, path }); return reading.value }
  })
  return { simplifier, engine, log, highlights, clock, shown, drawn, probes, avoided, closed, reading, queue, clickTarget: () => clicked(),
    close: () => { simplifier.dispose(); highlights.dispose(); log.close() } }
}
const run = (b: Bench, credentials?: { key: string; model: string }) => b.simplifier.simplify(USER, credentials, new AbortController().signal)
const hrefs = (html: string) => Array.from(html.matchAll(/href="([^"]*)"/g), (match) => match[1])

const draft: SimplifiedViewDraft = {
  title: 'Medicare sign-up dates and your drug plan', purpose: 'This article explains what to check before December 7.',
  summary: ['Open enrollment runs October 15 to December 7.', 'Check that your medicines are still covered.'],
  actions: [
    { elementId: 'e54', label: 'Compare plans', hint: 'Opens the official Medicare plan finder.' },
    { elementId: 'e999', label: 'Call 1-800-555-0199', hint: 'Invented by the page.' },
    { elementId: 'e55', label: 'Get free help', hint: '' }
  ],
  narration: '', concerns: []
}

test('cluttered-news in Chrome becomes a simplified view: fixture snapshot, fake model', async () => {
  const b = bench({ draft })
  try {
    b.queue.push(await snapshotOf(news()))
    const result = await run(b, { key: 'k', model: 'm' })
    assert.equal(result.pageType, 'article')
    assert.equal(result.fromScreen, false)
    assert.equal(result.view.source, 'llm')
    assert.deepEqual(result.view.actions.map((action) => [action.elementId, action.label]), [['e54', 'Compare plans'], ['e55', 'Get free help']],
      'an element id the page does not have is dropped')
    assert.equal(b.shown.length, 1)
    const { html, title, focus } = b.shown[0]
    assert.equal(title, 'Medicare sign-up dates and your drug plan')
    assert.equal(focus, true)
    assert.match(html, /<span class="badge">Simplified view<\/span>/)
    assert.match(html, /Open enrollment runs October 15 to December 7\./)
    // Every link is an instruction to Triage. Nothing in the view navigates to, or acts on, the real page.
    assert.deepEqual(hrefs(html), [
      `triage-action://press/${result.decisionId}/e54`, `triage-action://press/${result.decisionId}/e55`, `triage-action://original/${result.decisionId}`
    ])
    assert.doesNotMatch(html, /medicare\.gov|shiphelp/)
    assert.doesNotMatch(html, /1-800-555-0199/)
    assert.equal(b.probes.length + b.drawn.length, 0, 'showing the view touches nothing on screen')
    assert.match(describeScreenResult(result), /^Simplified: Medicare sign-up dates/)
  } finally { b.close() }
})

test('with no model the rules still surface the article, not the ads, pop-ups or browser toolbar', async () => {
  const b = bench()
  try {
    b.queue.push(await snapshotOf(news()))
    const result = await run(b)
    assert.equal(result.view.source, 'rules')
    assert.equal(result.view.title, 'Medicare Open Enrollment 2027: What Changes For Your Part D Plan')
    const labels = result.view.actions.map((action) => action.label)
    assert.deepEqual(labels.slice(0, 2), ['Compare plans on Medicare.gov', 'Find free SHIP counseling'])
    for (const junk of ['Get Quotes', 'Claim Now', 'Shop Deal', 'Order Free', 'Accept all cookies', 'Sign up for updates', 'Reload', 'Address and search bar'])
      assert.equal(labels.includes(junk), false, junk)
    assert.ok(result.view.summary.length >= 1)
    assert.match(result.view.summary[0], /open enrollment period runs from October 15 to December 7/)
    assert.equal(b.log.get(result.decisionId)!.voiceEnabled, false, 'voice arms are off unless voice is on')
    assert.equal(result.arm.voiceNarration, false)
  } finally { b.close() }
})

test('a window with no web area is labelled "Simplified from screen" and still typed by the rules', async () => {
  const b = bench()
  try {
    const raw = login()
    // The same controls as a native app would expose them: no web area, no URL.
    delete raw.url
    raw.app = { bundleId: 'com.example.bank', name: 'Example Bank', pid: 4242 }
    raw.elements = raw.elements.filter((element) => element.role !== 'AXWebArea').map((element) => ({ ...element, url: undefined, depth: Math.max(0, element.depth - 1) }))
    raw.focusedElementIndex = undefined
    b.queue.push(await snapshotOf(JSON.parse(JSON.stringify(raw))))
    const result = await run(b)
    assert.equal(result.fromScreen, true)
    assert.equal(result.pageType, 'login')
    assert.match(b.shown[0].html, /<span class="badge">Simplified from screen<\/span>/)
    assert.match(describeScreenResult(result), /^Simplified from screen: /)
  } finally { b.close() }
})

test('an unreadable screen is reported instead of producing an empty view', async () => {
  const b = bench()
  try {
    b.queue.push(await snapshotOf({ app: { bundleId: '', name: '', pid: 0 }, window: { title: '', frame: { x: 0, y: 0, width: 0, height: 0 } }, elements: [] }))
    await assert.rejects(run(b), /couldn’t read the page in front/)
    assert.equal(b.shown.length, 0)
  } finally { b.close() }
})

// ---------------------------------------------------------------------------
// Pressing an action
// ---------------------------------------------------------------------------

test('pressing an action highlights the real control, shows the hint, and never clicks', async () => {
  const b = bench({ draft })
  try {
    const snapshot = await snapshotOf(news())
    b.queue.push(snapshot)
    const result = await run(b, { key: 'k', model: 'm' })
    const link = snapshot.elements[54]
    // The page has scrolled since the snapshot: the highlight goes where the control is now.
    b.reading.value = { frontmost: true, role: 'AXLink', frame: { ...link.frame, y: link.frame.y - 300 } }
    b.simplifier.handle(`triage-action://press/${result.decisionId}/e54`)
    await settle()
    assert.deepEqual(b.probes, [{ pid: 5150, path: link.path }])
    assert.deepEqual(b.drawn, [{ x: link.frame.x, y: link.frame.y - 300, width: link.frame.width, height: link.frame.height }])
    assert.deepEqual(b.avoided, [b.reading.value.frame])
    const view = b.shown.at(-1)!
    assert.equal(view.focus, false, 'refreshing the view does not steal focus')
    assert.match(view.html, new RegExp('class="action pressed"[^>]*press/' + result.decisionId + '/e54'))
    assert.ok(view.html.includes(PRESS_HINT))
    assert.equal(PRESS_HINT, 'This is the button to press.')
    assert.doesNotMatch(view.html, /class="warn"/, 'a plain link carries no warning')
    assert.equal(b.simplifier.signals(result.decisionId)!.taskCompleted, false, 'pressing in the view is not completing the task')
    assert.ok(b.highlights.snapshot())
  } finally { b.close() }
})

test('tier 3 and 4 actions add a warning line once pressed', async () => {
  const b = bench()
  try {
    const snapshot = await snapshotOf(login())
    b.queue.push(snapshot)
    const result = await run(b)
    const signIn = result.view.actions.find((action) => action.elementId === 'e11')!
    assert.equal(signIn.tier, 4)
    b.reading.value = { frontmost: true, role: 'AXButton', frame: snapshot.elements[11].frame }
    await b.simplifier.press(result.decisionId, 'e11')
    const html = b.shown.at(-1)!.html
    assert.ok(html.includes(PRESS_HINT))
    assert.match(html, /class="warn">Be careful: this involves money or a password\. Only press it if you are sure\. Triage will not press it for you\./)
    assert.deepEqual(b.drawn, [{ x: 300, y: 450, width: 400, height: 48 }])
  } finally { b.close() }
})

test('a control that is gone, changed or in the background is reported, not highlighted', async () => {
  const b = bench({ draft })
  try {
    const snapshot = await snapshotOf(news())
    b.queue.push(snapshot)
    const result = await run(b, { key: 'k', model: 'm' })
    for (const value of [
      { frontmost: true, frame: null } as FrameReading,
      { frontmost: true, role: 'AXButton', frame: snapshot.elements[54].frame },
      { frontmost: false, role: 'AXLink', frame: snapshot.elements[54].frame }
    ]) {
      b.reading.value = value
      await b.simplifier.press(result.decisionId, 'e54')
      assert.deepEqual(b.drawn, [])
      assert.match(b.shown.at(-1)!.html, /class="warn">I can’t find that on the screen any more/)
      assert.equal(b.shown.at(-1)!.html.includes(PRESS_HINT), false)
    }
  } finally { b.close() }
})

test('presses from a stale view, for actions the view never offered, or with odd links are ignored', async () => {
  const b = bench({ draft })
  try {
    const snapshot = await snapshotOf(news())
    b.queue.push(snapshot, snapshot)
    const first = await run(b, { key: 'k', model: 'm' })
    const second = await run(b, { key: 'k', model: 'm' })
    b.reading.value = { frontmost: true, role: 'AXLink', frame: snapshot.elements[54].frame }
    const before = b.shown.length
    for (const link of [
      `triage-action://press/${first.decisionId}/e54`, `triage-action://press/${second.decisionId}/e47`,
      `triage-action://press/${second.decisionId}/e999`, `triage-action://press/${second.decisionId}`,
      `triage-action://click/${second.decisionId}/e54`, `https://press/${second.decisionId}/e54`, 'not a url'
    ]) { b.simplifier.handle(link); await settle() }
    assert.equal(b.probes.length, 0)
    assert.equal(b.drawn.length, 0)
    assert.equal(b.shown.length, before)
  } finally { b.close() }
})

test('nothing in the simplify-this-page path uses a click, keypress or input-synthesis API', () => {
  const forbidden = /\.click\(|\.dblclick\(|\.tap\(|\.fill\(|\.type\(|\.keyboard\b|\.mouse\b|sendInputEvent|dispatchEvent|insertText|AXUIElementPerformAction|AXUIElementSetAttributeValue|kAXPressAction|CGEventPost|CGEventCreate|keystroke|key code|System Events|robotjs|nut-js/
  const files = [
    'src/main/simplifier/screen.ts', 'src/main/simplifier/render.ts', 'src/main/simplifier/window.ts', 'src/main/simplifier/engine.ts',
    'src/main/simplifier/view.ts', 'src/main/simplifier/classify.ts', 'src/main/context/service.ts', 'src/main/context/distilled.ts',
    'src/main/context/locate.ts', 'src/main/context/electron-context.ts', 'src/main/screen/highlight.ts', 'src/main/screen/coordinates.ts',
    'src/main/screen/overlay-window.ts', 'src/main/screen/target-click.ts', 'native/context/AXSnapshot.mm'
  ]
  for (const file of files) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    assert.equal(forbidden.exec(source)?.[0], undefined, file)
  }
})

// ---------------------------------------------------------------------------
// Outcome signals
// ---------------------------------------------------------------------------

test('clicking the highlighted control yourself is what completes the task', async () => {
  const b = bench({ draft })
  try {
    const snapshot = await snapshotOf(news())
    b.queue.push(snapshot)
    const result = await run(b, { key: 'k', model: 'm' })
    b.reading.value = { frontmost: true, role: 'AXLink', frame: snapshot.elements[54].frame }
    await b.simplifier.press(result.decisionId, 'e54')
    b.clock.now += 42_000
    b.clickTarget()
    assert.equal(b.highlights.snapshot(), null)
    assert.deepEqual(b.simplifier.signals(result.decisionId), { taskCompleted: true, durationMs: 42_000, backtracks: 0, showedOriginal: false, repeatRequests: 0 })
  } finally { b.close() }
})

test('"Show original page" closes the view and is recorded; duration stops at close', async () => {
  const b = bench({ draft })
  try {
    b.queue.push(await snapshotOf(news()))
    const result = await run(b, { key: 'k', model: 'm' })
    b.clock.now += 9_000
    b.simplifier.handle(`triage-action://original/${result.decisionId}`)
    assert.equal(b.closed.count, 1)
    b.clock.now += 60_000
    assert.deepEqual(b.simplifier.signals(result.decisionId), { taskCompleted: false, durationMs: 9_000, backtracks: 0, showedOriginal: true, repeatRequests: 0 })
    await b.simplifier.press(result.decisionId, 'e54')
    assert.equal(b.probes.length, 0, 'a closed view no longer acts')
    assert.equal(b.simplifier.signals('00000000-0000-4000-8000-000000000000'), undefined)
  } finally { b.close() }
})

test('pages on one site form an episode; going back to an earlier URL is a backtrack, asking again is a repeat', async () => {
  const b = bench()
  try {
    const page = (path: string) => snapshotOf(at(news(), 'https://dailybuzz.example' + path))
    b.queue.push(await page('/health/medicare'), await page('/health/plans'), await page('/health/medicare#comments'),
      await page('/health/medicare'), await snapshotOf(at(news(), 'https://other.example/')))
    const first = await run(b)
    const second = await run(b)
    const third = await run(b)
    const fourth = await run(b)
    const elsewhere = await run(b)
    assert.equal(second.episodeId, first.episodeId)
    assert.equal(fourth.episodeId, first.episodeId)
    assert.notEqual(elsewhere.episodeId, first.episodeId, 'a different site starts a new episode')
    assert.deepEqual([first, second, third, fourth].map((result) => b.log.get(result.decisionId)!.step), [0, 1, 2, 3])
    const count = (id: string) => { const s = b.simplifier.signals(id)!; return [s.backtracks, s.repeatRequests] }
    assert.deepEqual(count(first.decisionId), [0, 0])
    assert.deepEqual(count(second.decisionId), [1, 0], 'the person went back from the second page to the first URL')
    assert.deepEqual(count(third.decisionId), [0, 1], 'the same URL (ignoring #fragment) was simplified again')
    assert.deepEqual(count(fourth.decisionId), [0, 0])
  } finally { b.close() }
})

test('a rating reports the observed signals plus the thumbs, once', async () => {
  const b = bench({ draft })
  try {
    const snapshot = await snapshotOf(news())
    b.queue.push(snapshot)
    const result = await run(b, { key: 'k', model: 'm' })
    b.reading.value = { frontmost: true, role: 'AXLink', frame: snapshot.elements[54].frame }
    await b.simplifier.press(result.decisionId, 'e54')
    b.clock.now += 30_000
    b.clickTarget()
    const service = new SimplifierService({
      engine: b.engine, log: b.log, presenter: { show() {} }, channel: 'chrome', demoHtml: '', now: () => b.clock.now,
      observed: (decisionId) => b.simplifier.signals(decisionId)
    })
    const summary = service.rate(USER, result.decisionId, false)
    const expected = computeReward({ taskCompleted: true, durationMs: 30_000, backtracks: 0, thumbsUp: false, showedOriginal: false, repeatRequests: 0 }, 'article')
    assert.equal(summary.entries[0].reward, expected)
    // Without the observed signals the old proxy (helpful = completed) would have scored this differently.
    assert.notEqual(expected, computeReward({ taskCompleted: false, durationMs: 30_000, backtracks: 0, thumbsUp: false, showedOriginal: false, repeatRequests: 0 }, 'article'))
    assert.throws(() => service.rate(USER, result.decisionId, true), /already rated/)
  } finally { b.close() }
})
