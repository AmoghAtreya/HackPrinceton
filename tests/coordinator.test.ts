import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { AppProblem } from '../src/main/assistant/errors.ts'
import type { ModelGateway, DialogueTurn } from '../src/main/assistant/model.ts'

const KEY = 'unit-test-only-key-not-a-real-provider-credential'
const MODELS = [{ id: 'claude-test', label: 'Unit test model' }]

async function fixture(overrides: Partial<ModelGateway> = {}, configured = true, requestTimeout = 1000) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-coordinator-'))
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, {
    available: async () => false, encrypt: async () => { throw new Error('unavailable') },
    decrypt: async () => { throw new Error('unavailable') }
  })
  if (configured) await credentials.connect(KEY, false, MODELS)
  const gateway: ModelGateway = {
    models: async () => MODELS,
    reply: async () => 'A real adapter would produce this text.',
    ...overrides
  }
  const service = new AssistantCoordinator({ history, credentials, gateway, changed: () => {}, requestTimeout })
  return {
    service, history, file: join(directory, 'history.sqlite'),
    cleanup: () => { service.dispose(); rmSync(directory, { recursive: true, force: true }) }
  }
}

test('requests are persisted before dispatch and follow-ups include completed context', async () => {
  const seen: DialogueTurn[][] = []
  let checkSaved = () => {}
  const f = await fixture({ reply: async (_key, _model, messages) => {
    checkSaved(); seen.push(messages); return 'Response ' + seen.length
  } })
  try {
    checkSaved = () => { assert.equal(f.history.list().items.length, 1) }
    const first = f.service.send({ text: 'My project is Triage.' })
    await tick()
    assert.equal(f.history.detail(first.conversationId).messages[0].status, 'completed')
    f.service.send({ text: 'What is the project?', conversationId: first.conversationId })
    await tick()
    assert.deepEqual(seen[1].map((m) => m.content), ['My project is Triage.', 'Response 1', 'What is the project?'])
    assert.equal(f.service.snapshot().active, null)
  } finally { f.cleanup() }
})

test('stop aborts the request and ignores late responses even if the gateway ignores abort', async () => {
  let resolve!: (value: string) => void
  let signal!: AbortSignal
  const f = await fixture({ reply: async (_key, _model, _messages, current) => {
    signal = current
    return new Promise<string>((done) => { resolve = done })
  } })
  try {
    const request = f.service.send({ text: 'Please stop me.' })
    assert.throws(() => f.service.send({ text: 'Overlapping request' }), /current request/)
    assert.throws(() => f.service.deleteConversation(request.conversationId), /Stop/)
    assert.throws(() => f.service.removeKey(), /current request/)
    f.service.stop(request.taskId)
    assert.equal(signal.aborted, true)
    resolve('This late reply must never be shown or saved.')
    await tick()
    const messages = f.history.detail(request.conversationId).messages
    assert.equal(messages.length, 1)
    assert.equal(messages[0].status, 'stopped')
    assert.equal(f.service.snapshot().active, null)
  } finally { f.cleanup() }
})

test('provider failure is saved as a failure without leaking arbitrary error contents', async () => {
  const f = await fixture({ reply: async () => { throw new Error(KEY) } })
  try {
    const request = f.service.send({ text: 'Fail safely.' })
    await tick()
    const detail = f.history.detail(request.conversationId)
    assert.equal(detail.messages[0].status, 'failed')
    assert.ok(!JSON.stringify(detail).includes(KEY))
    assert.equal(f.service.snapshot().active, null)
  } finally { f.cleanup() }
})

test('a bounded deadline fails a hung request and rejects its eventual reply', async () => {
  let resolve!: (value: string) => void
  const f = await fixture({ reply: async () => new Promise<string>((done) => { resolve = done }) }, true, 15)
  try {
    const request = f.service.send({ text: 'A deliberately slow test.' })
    await delay(35)
    assert.equal(f.service.snapshot().active, null)
    assert.equal(f.history.detail(request.conversationId).messages[0].status, 'failed')
    resolve('Too late.')
    await tick()
    assert.equal(f.history.detail(request.conversationId).messages.length, 1)
  } finally { f.cleanup() }
})

test('storage failure blocks network dispatch and further requests', async () => {
  let calls = 0
  const f = await fixture({ reply: async () => { calls++; return 'Must not run' } })
  try {
    f.history.begin = () => { throw new AppProblem('storage', 'disk full') }
    assert.throws(() => f.service.send({ text: 'Do not transmit.' }), /disk full/)
    assert.equal(calls, 0)
    assert.ok(f.service.snapshot().storageError)
    assert.throws(() => f.service.send({ text: 'Still blocked.' }), /paused/)
  } finally { f.cleanup() }
})

test('missing keys and malformed inputs do not create accepted requests', async () => {
  const f = await fixture({}, false)
  try {
    assert.throws(() => f.service.send({ text: 'Hello' }), /Settings/)
    await assert.rejects(f.service.connect({ key: 'short', remember: false }))
    assert.throws(() => f.service.send({ text: 'x'.repeat(4001) }))
    assert.throws(() => f.service.send({ text: 'Hello', runShell: true }))
    assert.equal(f.history.list().items.length, 0)
    await f.service.connect({ key: KEY, remember: false })
    assert.equal(f.service.snapshot().config.configured, true)
    assert.ok(!JSON.stringify(f.service.snapshot()).includes(KEY))
  } finally { f.cleanup() }
})

test('failure to persist a reply blocks requests and recovers the unfinished turn', async () => {
  const f = await fixture()
  try {
    f.history.complete = () => { throw new AppProblem('storage', 'reply write failed') }
    const request = f.service.send({ text: 'Do not report an unsaved reply as complete.' })
    await tick()
    assert.equal(f.service.snapshot().active, null)
    assert.ok(f.service.snapshot().storageError)
    assert.equal(f.history.detail(request.conversationId).messages.length, 1)
    f.service.dispose()
    const reopened = new HistoryStore(f.file)
    assert.equal(reopened.detail(request.conversationId).messages[0].status, 'interrupted')
    reopened.close()
  } finally { f.cleanup() }
})

test('the active key is removed from outbound context and stored replies', async () => {
  let outbound = ''
  const f = await fixture({ reply: async (_key, _model, messages) => {
    outbound = JSON.stringify(messages); return 'Echoing a test key: ' + KEY
  } })
  try {
    const request = f.service.send({ text: 'Here is a key that must be redacted: ' + KEY })
    await tick()
    assert.ok(!outbound.includes(KEY))
    assert.ok(!JSON.stringify(f.history.detail(request.conversationId)).includes(KEY))
  } finally { f.cleanup() }
})

test('shutdown records a stopped request and prevents writes after closing the database', async () => {
  let resolve!: (value: string) => void
  const f = await fixture({ reply: async () => new Promise<string>((done) => { resolve = done }) })
  try {
    const request = f.service.send({ text: 'Quit during this request.' })
    f.service.dispose()
    f.service.dispose()
    resolve('A response after shutdown.')
    await tick()
    const reopened = new HistoryStore(f.file)
    assert.equal(reopened.detail(request.conversationId).messages[0].status, 'stopped')
    assert.equal(reopened.detail(request.conversationId).messages.length, 1)
    reopened.close()
  } finally { f.cleanup() }
})

test('thinking status is durable before dispatch and a failed status write prevents dispatch', async () => {
  let calls = 0
  const f = await fixture({ reply: async () => {
    calls++
    const id = f.history.list().items[0].id
    assert.ok(f.history.detail(id).activity?.some((event) => event.type === 'request_status' && event.detail === 'Thinking…'))
    return 'Saved reply'
  } })
  try {
    f.service.send({ text: 'Persist status first.' }); await tick()
    assert.equal(calls, 1)
    f.history.activity = () => { throw new AppProblem('storage', 'disk full') }
    assert.throws(() => f.service.send({ text: 'Do not start without a status record.' }), /disk full/)
    assert.equal(calls, 1)
    assert.ok(f.service.snapshot().storageError)
  } finally { f.cleanup() }
})

test('lifecycle interruption aborts work, survives restart, and discards a late reply', async () => {
  let resolve!: (value: string) => void
  let signal!: AbortSignal
  const f = await fixture({ reply: async (_key, _model, _context, current) => {
    signal = current
    return new Promise<string>((done) => { resolve = done })
  } })
  try {
    const request = f.service.send({ text: 'Sleep during this request.' })
    f.service.interrupt('Interrupted because this Mac went to sleep.')
    assert.equal(signal.aborted, true)
    assert.equal(f.service.snapshot().active, null)
    resolve('Must not appear after resume.'); await tick()
    f.service.dispose()
    const restored = new HistoryStore(f.file)
    try {
      const detail = restored.detail(request.conversationId)
      assert.equal(detail.messages.length, 1)
      assert.equal(detail.messages[0].status, 'interrupted')
      assert.match(detail.messages[0].error!, /sleep/)
      assert.equal(detail.activity?.filter((event) => event.type === 'request_interrupted').length, 1)
    } finally { restored.close() }
    assert.throws(() => f.service.deleteConversation(request.conversationId), /closing/)
  } finally { f.cleanup() }
})

test('failed history deletion blocks later network requests', async () => {
  for (const method of ['delete', 'clear'] as const) {
    let calls = 0
    const f = await fixture({ reply: async () => { calls++; return 'Saved reply' } })
    try {
      const request = f.service.send({ text: 'Keep this until deletion succeeds.' }); await tick()
      f.history[method] = () => { throw new AppProblem('storage', 'disk write failed') }
      assert.throws(() => method === 'delete' ? f.service.deleteConversation(request.conversationId) : f.service.clearHistory(), /disk write failed/)
      assert.ok(f.service.snapshot().storageError)
      assert.throws(() => f.service.send({ text: 'No further dispatch.' }), /paused/)
      assert.equal(calls, 1)
      assert.equal(f.history.list().items.length, 1)
    } finally { f.cleanup() }
  }
})
