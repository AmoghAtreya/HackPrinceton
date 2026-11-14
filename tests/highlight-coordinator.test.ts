import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { AppProblem } from '../src/main/assistant/errors.ts'
import { ScreenService } from '../src/main/screen/service.ts'
import { HighlightController } from '../src/main/screen/highlight.ts'
import type { HighlightReply } from '../src/shared/highlight-contracts.ts'

const target = { x: 0.1, y: 0.2, width: 0.2, height: 0.1 }
const DATA = Buffer.from('not-a-real-screenshot').toString('base64')
async function fixture(locate?: () => Promise<HighlightReply>) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-highlight-'))
  const file = join(directory, 'history.sqlite')
  const history = new HistoryStore(file)
  const credentials = new Credentials(directory, {
    available: async () => false, encrypt: async () => Buffer.alloc(0),
    decrypt: async () => ({ result: '', shouldReEncrypt: false })
  })
  await credentials.connect('fixture-key-not-real', false, [{ id: 'claude-test', label: 'Fixture' }])
  const bounds = { x: -2000, y: 0, width: 2000, height: 1000 }
  let drawn = 0
  let providerCalls = 0
  let captureId = ''
  let savedBeforeDraw = false
  let coordinator!: AssistantCoordinator
  const highlights = new HighlightController({
    display: () => ({ bounds }), hide: () => {},
    draw: (state) => {
      drawn++
      assert.equal(coordinator.snapshot().active, null)
      savedBeforeDraw = history.detail(coordinator.snapshot().gestureRequest?.conversationId ??
        history.list().items[0].id).messages.some((message) => message.role === 'assistant')
      assert.equal(state.expiresAt, null)
    }
  })
  const screens = new ScreenService({
    permission: () => 'granted', capture: async () => ({
      data: DATA, mediaType: 'image/jpeg',
      metadata: { displayId: 'fixture', redactedRegions: 0, displayName: 'Fixture', width: 1000, height: 500,
        bounds, cursor: { x: 100, y: 100 } }
    })
  })
  coordinator = new AssistantCoordinator({
    history, credentials, screens, highlights, changed: () => {},
    gateway: {
      models: async () => [], reply: async () => 'Text reply',
      locate: async (_key, _model, _messages, _signal, image) => {
        providerCalls++; captureId = image.metadata.id
        return locate ? locate() : { explanation: 'The control is here.', captureId, target }
      }
    }
  })
  const capture = async () => { const preview = await screens.capture(); captureId = preview.metadata.id; return preview }
  return {
    coordinator, history, highlights, screens, capture, file,
    currentId: () => captureId, counts: () => ({ drawn, providerCalls, savedBeforeDraw }),
    close: () => { coordinator.dispose(); highlights.dispose(); screens.dispose(); rmSync(directory, { recursive: true, force: true }) }
  }
}

test('localization completes and persists before native drawing without saving image bytes', async () => {
  const f = await fixture()
  try {
    const preview = await f.capture()
    const receipt = f.coordinator.send({ text: 'Where is save?', captureId: preview.metadata.id, mode: 'highlight' })
    await tick()
    assert.deepEqual(f.counts(), { drawn: 1, providerCalls: 1, savedBeforeDraw: true })
    assert.match(f.history.detail(receipt.conversationId).messages[0].content, /Show me where/)
    const db = new DatabaseSync(f.file)
    const events = JSON.stringify(db.prepare('SELECT payload_json FROM events').all())
    db.close()
    assert.match(events, /highlight/)
    assert.match(events, /prepared/)
    assert.ok(!events.includes(DATA))
    f.coordinator.clearHighlight()
    assert.equal(f.coordinator.snapshot().highlight, undefined)
  } finally { f.close() }
})
test('Stop discards a late localization response without a reply or marker', async () => {
  let resolve!: (value: HighlightReply) => void
  const f = await fixture(() => new Promise((done) => { resolve = done }))
  try {
    const preview = await f.capture()
    const receipt = f.coordinator.send({ text: 'Where is save?', captureId: preview.metadata.id, mode: 'highlight' })
    f.coordinator.stop(receipt.taskId)
    resolve({ explanation: 'Too late', captureId: preview.metadata.id, target })
    await tick()
    assert.equal(f.counts().drawn, 0)
    assert.equal(f.history.detail(receipt.conversationId).messages.length, 1)
    assert.equal(f.history.detail(receipt.conversationId).messages[0].status, 'stopped')
  } finally { f.close() }
})
test('capture invalidation keeps useful explanation but refuses the stale marker', async () => {
  let resolve!: (value: HighlightReply) => void
  const f = await fixture(() => new Promise((done) => { resolve = done }))
  try {
    const preview = await f.capture()
    const receipt = f.coordinator.send({ text: 'Where is save?', captureId: preview.metadata.id, mode: 'highlight' })
    f.coordinator.clearHighlight()
    resolve({ explanation: 'Here is the visible control.', captureId: preview.metadata.id, target })
    await tick()
    assert.equal(f.counts().drawn, 0)
    assert.match(f.history.detail(receipt.conversationId).messages[1].content, /No highlight/)
  } finally { f.close() }
})
test('ambiguous targets and mismatched capture IDs never create a marker', async () => {
  for (const mismatch of [false, true]) {
    let f!: Awaited<ReturnType<typeof fixture>>
    f = await fixture(async () => ({ explanation: 'Please clarify.', captureId: mismatch ? 'wrong-capture' : f.currentId(), target: mismatch ? target : null }))
    try {
      const preview = await f.capture()
      f.coordinator.send({ text: 'Where?', captureId: preview.metadata.id, mode: 'highlight' })
      await tick()
      assert.equal(f.counts().drawn, 0)
      assert.equal(f.history.detail(f.history.list().items[0].id).messages.length, 2)
    } finally { f.close() }
  }
})
test('a write failure prevents display and blocks further requests', async (t) => {
  const f = await fixture()
  try {
    const preview = await f.capture()
    t.mock.method(f.history, 'complete', () => { throw new AppProblem('storage', 'Fixture write failure') })
    f.coordinator.send({ text: 'Where?', captureId: preview.metadata.id, mode: 'highlight' })
    await tick()
    assert.equal(f.counts().drawn, 0)
    assert.ok(f.coordinator.snapshot().storageError)
    t.mock.restoreAll()
  } finally { f.close() }
})
test('a new text task clears the prior marker and missing capture input is rejected', async () => {
  const f = await fixture()
  try {
    assert.throws(() => f.coordinator.send({ text: 'Where?', mode: 'highlight' }), /request fields/)
    const preview = await f.capture()
    f.coordinator.send({ text: 'Where?', captureId: preview.metadata.id, mode: 'highlight' })
    await tick()
    assert.ok(f.highlights.snapshot())
    f.coordinator.send({ text: 'Hello' })
    assert.equal(f.highlights.snapshot(), null)
    await tick()
  } finally { f.close() }
})
test('saved highlight shake actions share the same capture and drawing path', async () => {
  const f = await fixture()
  try {
    const receipt = f.coordinator.shake({ point: { x: -1000, y: 100 }, displayId: 'fixture', triggeredAt: Date.now() },
      'Show the save control', f.capture, 'highlight')!
    await tick()
    assert.equal(f.counts().drawn, 1)
    assert.equal(f.history.detail(receipt.conversationId).messages[0].status, 'completed')
  } finally { f.close() }
})
