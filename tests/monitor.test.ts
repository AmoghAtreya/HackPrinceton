import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningMonitor, mask, type StampedEvent } from '../src/main/monitor/bus.ts'
import { MonitorCallbackHandler } from '../src/main/monitor/callbacks.ts'
import { MonitorServer } from '../src/main/monitor/server.ts'
import { MemoryService, parseRememberCommand } from '../src/main/memory/service.ts'
import { SqliteCheckpointer } from '../src/main/tasks/checkpointer.ts'
import { TaskRunner } from '../src/main/tasks/runner.ts'
import { DecisionLog } from '../src/main/simplifier/decision-log.ts'
import { ThompsonPolicy } from '../src/main/simplifier/thompson.ts'
import { SimplificationEngine } from '../src/main/simplifier/engine.ts'
import { seededRandom } from '../src/main/simplifier/linalg.ts'
import { RiskTier, type DistilledPage } from '../src/shared/simplifier-contracts.ts'

test('masking hides prescription, card, date of birth and email values but keeps years', () => {
  assert.equal(mask('my blood pressure medication is RX-48213'), 'my blood pressure medication is RX-•••13')
  assert.equal(mask('card 4111111111111111'), 'card ••••••11')
  assert.equal(mask('born 04/12/1951'), 'born ••/••/••••')
  assert.equal(mask('write to sam@example.com'), 'write to •••@•••')
  assert.equal(mask('Medicare 2027 plans'), 'Medicare 2027 plans')
})

test('the monitor keeps a bounded backlog and masks before publishing', () => {
  const monitor = new LearningMonitor(3)
  const seen: StampedEvent[] = []
  monitor.subscribe((event) => seen.push(event))
  for (let i = 0; i < 5; i++) monitor.emit({ type: 'note', text: 'step ' + i })
  monitor.emit({ type: 'memory', action: 'saved', kind: 'preference', text: 'my lisinopril prescription number 774512' })
  assert.equal(monitor.since().length, 3)
  assert.equal(monitor.since(5).length, 1)
  const last = seen.at(-1)!
  assert.ok(last.type === 'memory' && /••••12$/.test(last.text))
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'triage-monitor-'))
  const monitor = new LearningMonitor()
  const events: StampedEvent[] = []
  monitor.subscribe((event) => events.push(event))
  const callbacks = [new MonitorCallbackHandler(monitor)]
  return { directory, monitor, events, callbacks, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('a refill run shows LangGraph nodes, a retrieval, memory writes and the pause', async () => {
  const { directory, monitor, events, callbacks, cleanup } = fixture()
  const memory = new MemoryService(join(directory, 'memory.sqlite'), monitor)
  const file = join(directory, 'tasks.sqlite')
  const checkpointer = new SqliteCheckpointer(file)
  const driver = {
    site: 'pharmacy.triage-demo.invalid', open: async () => {}, submitTier: async () => RiskTier.Commit,
    fill: async (form: { rx: string }) => [{ label: 'Prescription number', value: form.rx }], submit: async () => ({ confirmation: 'RF-123456' })
  }
  const runner = new TaskRunner({ file, memory, driver, checkpointer, monitor, callbacks })
  try {
    for (const text of ['my name is Margaret Lee', 'my date of birth is 04/12/1951', 'my pharmacy is CareWell on Main Street', 'I prefer to pick up in the morning', 'my blood pressure medication is RX-48213']) {
      const statement = parseRememberCommand('remember that ' + text)!
      await memory.remember(statement.kind, statement.text, { ...(statement.key ? { key: statement.key } : {}), ...(statement.extra ?? {}) })
    }
    await runner.start('conv', 'refill my blood pressure medicine', () => {})
    const nodes = events.filter((event) => event.type === 'run' && event.phase === 'start' && event.node).map((event) => (event as { node: string }).node)
    assert.deepEqual(nodes, ['recall', 'gather', 'open', 'fill', 'confirm'])
    assert.ok(events.some((event) => event.type === 'retrieval' && event.hits.length > 0 && event.hits.every((hit) => !/48213/.test(hit.text))), 'retrieval shown, prescription masked')
    assert.ok(events.some((event) => event.type === 'interrupt' && event.kind === 'confirm'))
    assert.equal(events.filter((event) => event.type === 'memory').length, 5)
    await runner.resume('conv', 'yes', () => {})
    const after = events.filter((event) => event.type === 'run' && event.phase === 'start' && event.node).map((event) => (event as { node: string }).node)
    assert.ok(after.includes('submit') && after.includes('remember'))
  } finally { runner.close(); checkpointer.close(); memory.close(); cleanup() }
})

test('a simplification shows the four LangChain pipeline steps, layout odds and the reward', async () => {
  const { monitor, events, callbacks, cleanup } = fixture()
  const log = new DecisionLog(':memory:')
  const engine = new SimplificationEngine({ log, policy: new ThompsonPolicy({ propensitySamples: 20 }, seededRandom(1)), monitor, callbacks })
  const page: DistilledPage = {
    url: 'https://news.example/a', title: 'News', lang: 'en', mainText: 'x'.repeat(2000), capturedAt: 0,
    elements: [{ id: 'e0', kind: 'button', label: 'Continue', region: 'main', area: 0.01, top: 0.2 }],
    stats: { totalElements: 100, interactiveElements: 1, maxNavDepth: 1, textLength: 2000, hiddenRemoved: 0 }
  }
  try {
    const result = await engine.simplify({ page, userId: 'u', voiceEnabled: false })
    const steps = events.filter((event) => event.type === 'run' && event.phase === 'start').map((event) => (event as { name: string }).name)
    for (const step of ['simplify_page', 'classify_page', 'choose_layout', 'rewrite_page', 'log_decision']) assert.ok(steps.includes(step), step)
    const bandit = events.find((event) => event.type === 'bandit')
    assert.ok(bandit && bandit.type === 'bandit')
    assert.ok(Math.abs(Object.values(bandit.shares).reduce((a, b) => a + b, 0) - 1) < 1e-9)
    engine.reportOutcome(result.decisionId, { taskCompleted: true, durationMs: 30000, backtracks: 0, thumbsUp: true, showedOriginal: false, repeatRequests: 0 })
    const reward = events.find((event) => event.type === 'reward')
    assert.ok(reward && reward.type === 'reward' && reward.rated === 1)
  } finally { log.close(); cleanup() }
})

test('the monitor server needs its token and streams the backlog', async () => {
  const monitor = new LearningMonitor()
  monitor.emit({ type: 'note', text: 'hello' })
  const server = new MonitorServer(monitor)
  const { localUrl } = await server.start()
  try {
    const base = new URL(localUrl)
    assert.equal((await fetch(base.origin + '/')).status, 404)
    const page = await fetch(localUrl)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'nonce-/)
    const controller = new AbortController()
    const stream = await fetch(base.origin + '/events?t=' + server.token, { signal: controller.signal })
    const reader = stream.body!.getReader()
    const { value } = await reader.read()
    assert.match(new TextDecoder().decode(value), /"text":"hello"/)
    controller.abort()
  } finally { await server.close() }
})
