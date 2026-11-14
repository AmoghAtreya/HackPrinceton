import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { AppProblem } from '../src/main/assistant/errors.ts'
import { ScreenService, type CapturePort } from '../src/main/screen/service.ts'
import type { ScreenImage } from '../src/shared/screen-contracts.ts'

const DATA = Buffer.from('synthetic-shake-image-only').toString('base64')
const trigger = { point: { x: -400, y: 120 }, displayId: 'two', triggeredAt: 123456 }
const captured = {
  data: DATA, mediaType: 'image/jpeg' as const,
  metadata: { displayId: 'two', displayName: 'Fixture display', width: 800, height: 600,
    bounds: { x: -800, y: 0, width: 800, height: 600 }, cursor: { x: 400, y: 120 } }
}
async function fixture(options: {
  capture?: CapturePort['capture']; configured?: boolean; requestTimeout?: number;
  reply?: (image?: ScreenImage) => Promise<string>
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-shake-request-'))
  const file = join(directory, 'history.sqlite')
  const history = new HistoryStore(file)
  const credentials = new Credentials(directory, {
    available: async () => false, encrypt: async () => Buffer.alloc(0),
    decrypt: async () => ({ result: '', shouldReEncrypt: false })
  })
  if (options.configured !== false) await credentials.connect('fixture-key-not-real', false, [{ id: 'claude-test', label: 'Fixture' }])
  let captures = 0
  let replies = 0
  const screens = new ScreenService({
    permission: () => 'granted',
    capture: async (input) => { captures++; return options.capture ? options.capture(input) : captured }
  })
  const coordinator = new AssistantCoordinator({
    history, credentials, screens, changed: () => {}, requestTimeout: options.requestTimeout,
    gateway: { models: async () => [], reply: async (_key, _model, _messages, _signal, image) => {
      replies++; return options.reply ? options.reply(image) : 'Synthetic screen explanation.'
    } }
  })
  return {
    history, screens, coordinator, file, counts: () => ({ captures, replies }),
    capture: () => screens.capture({ cursor: trigger.point, focusAfterCapture: false }),
    close: () => { screens.dispose(); coordinator.dispose(); rmSync(directory, { recursive: true, force: true }) }
  }
}

test('shake saves instruction and trigger before capture then attaches only metadata before replying', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>
  f = await fixture({ capture: async (options) => {
    assert.deepEqual(options, { cursor: trigger.point, focusAfterCapture: false })
    assert.match(f.history.detail(f.coordinator.snapshot().active!.conversationId).messages[0].content, /Summarize/)
    assert.equal(f.coordinator.snapshot().active?.stage, 'capturing')
    return captured
  }, reply: async (image) => {
    assert.equal(image?.data, DATA)
    assert.equal(f.coordinator.snapshot().active?.stage, 'thinking')
    return 'A fixture explanation.'
  } })
  try {
    const receipt = f.coordinator.shake(trigger, 'Summarize fixture-key-not-real in two lines', f.capture)!
    await tick()
    assert.equal(f.history.detail(receipt.conversationId).messages[0].status, 'completed')
    assert.equal(f.history.detail(receipt.conversationId).messages.length, 2)
    assert.deepEqual(f.counts(), { captures: 1, replies: 1 })
    const db = new DatabaseSync(f.file)
    const events = db.prepare('SELECT type,payload_json FROM events ORDER BY seq').all()
    db.close()
    const stored = JSON.stringify(events)
    assert.match(stored, /screen_captured/)
    assert.match(stored, /shake/)
    assert.match(stored, /123456/)
    assert.match(stored, /Summarize/)
    assert.ok(!stored.includes(DATA))
    assert.ok(!stored.includes('fixture-key-not-real'))
  } finally { f.close() }
})

test('busy shake is saved as skipped without capture queuing or replacing the active task', async () => {
  let resolve!: (text: string) => void
  const f = await fixture({ reply: () => new Promise((done) => { resolve = done }) })
  try {
    const first = f.coordinator.shake(trigger, 'First instruction', f.capture)!
    await tick()
    const second = f.coordinator.shake(trigger, 'Second instruction', f.capture)!
    assert.equal(f.coordinator.snapshot().active?.id, first.taskId)
    assert.equal(f.coordinator.snapshot().gestureRequest?.taskId, first.taskId)
    assert.match(f.history.detail(second.conversationId).messages[0].error!, /skipped/)
    assert.deepEqual(f.counts(), { captures: 1, replies: 1 })
    resolve('Only the first result')
    await tick()
    assert.equal(f.history.detail(second.conversationId).messages.length, 1)
  } finally { f.close() }
})

test('Stop during capture rejects the eventual image and never dispatches a model request', async () => {
  let resolve!: (image: typeof captured) => void
  const f = await fixture({ capture: () => new Promise((done) => { resolve = done }) })
  try {
    const receipt = f.coordinator.shake(trigger, 'Explain the fixture', f.capture)!
    assert.throws(() => f.coordinator.send({ text: 'Overlap' }), /current request/)
    f.coordinator.stop(receipt.taskId)
    resolve(captured)
    await tick()
    assert.deepEqual(f.counts(), { captures: 1, replies: 0 })
    assert.equal(f.history.detail(receipt.conversationId).messages[0].status, 'stopped')
    assert.throws(() => f.screens.take('no-reusable-image'), /expired/)
  } finally { f.close() }
})

test('capture failure and missing credentials remain visible in History without network dispatch', async () => {
  for (const configured of [true, false]) {
    const f = await fixture({ configured, capture: async () => { throw new AppProblem('screen_permission', 'Allow screen permission in System Settings.') } })
    try {
      const receipt = f.coordinator.shake(trigger, 'Explain this', f.capture)!
      await tick()
      const message = f.history.detail(receipt.conversationId).messages[0]
      assert.equal(message.status, 'failed')
      assert.match(message.error!, configured ? /System Settings/ : /API key/)
      assert.deepEqual(f.counts(), { captures: configured ? 1 : 0, replies: 0 })
    } finally { f.close() }
  }
})

test('storage failure blocks capture or model dispatch at both persistence boundaries', async (t) => {
  for (const boundary of ['begin', 'attachCapture'] as const) {
    const f = await fixture()
    try {
      t.mock.method(f.history, boundary, () => { throw new AppProblem('storage', 'Write failed') })
      if (boundary === 'begin') assert.throws(() => f.coordinator.shake(trigger, 'Explain', f.capture), /Write failed/)
      else { f.coordinator.shake(trigger, 'Explain', f.capture); await tick() }
      assert.ok(f.coordinator.snapshot().storageError)
      assert.deepEqual(f.counts(), { captures: boundary === 'begin' ? 0 : 1, replies: 0 })
      t.mock.restoreAll()
    } finally { f.close() }
  }
})

test('a disconnected trigger display cannot send a replacement display image', async () => {
  const f = await fixture({ capture: async () => ({ ...captured, metadata: { ...captured.metadata, displayId: 'replacement' } }) })
  try {
    const receipt = f.coordinator.shake(trigger, 'Explain this display', f.capture)!
    await tick()
    assert.match(f.history.detail(receipt.conversationId).messages[0].error!, /display changed/)
    assert.equal(f.counts().replies, 0)
  } finally { f.close() }
})

test('deadline and shutdown during capture reject late provider dispatch', async () => {
  for (const outcome of ['deadline', 'shutdown']) {
    let resolve!: (image: typeof captured) => void
    const f = await fixture({ requestTimeout: 20, capture: () => new Promise((done) => { resolve = done }) })
    try {
      f.coordinator.shake(trigger, 'Explain the fixture', f.capture)
      if (outcome === 'deadline') await delay(35)
      else f.coordinator.dispose()
      resolve(captured)
      await tick()
      assert.equal(f.counts().replies, 0)
      assert.equal(f.coordinator.snapshot().active, null)
    } finally { f.close() }
  }
})
