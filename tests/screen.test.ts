import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { ScreenService, type CapturePort } from '../src/main/screen/service.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { ClaudeGateway } from '../src/main/assistant/model.ts'

const DATA = Buffer.from('disposable-test-image-not-a-real-screen').toString('base64')
function port(): CapturePort {
  return {
    permission: () => 'granted',
    capture: async () => ({
      data: DATA, mediaType: 'image/jpeg',
      metadata: {
        displayId: 'fixture', redactedRegions: 0, displayName: 'Test display', width: 1280, height: 800,
        bounds: { x: -1440, y: 0, width: 1440, height: 900 }, cursor: { x: 640, y: 400 }
      }
    })
  }
}

test('permission denial does not call capture and gives Mac recovery instructions', async () => {
  let called = false
  const screens = new ScreenService({ ...port(), permission: () => 'denied', capture: async () => { called = true; throw Error() } })
  await assert.rejects(screens.capture(), /System Settings/)
  assert.equal(called, false)
  screens.dispose()
})

test('permission errors identify status and the running bundle without capturing', async () => {
  const screens = new ScreenService({ ...port(), permission: () => 'denied',
    permissionHelp: () => 'Add /test/Triage.app and fully quit.',
    capture: async () => { throw Error('native capture must not run') }
  })
  await assert.rejects(screens.capture(), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /denied/)
    assert.match(error.message, /\/test\/Triage\.app/)
    assert.match(error.message, /fully quit/)
    return true
  })
  screens.dispose()
})

test('unset screen permission returns recovery without entering native capture', async () => {
  const screens = new ScreenService({ ...port(), permission: () => 'not-determined', capture: async () => { throw Error('native capture must not run') } })
  await assert.rejects(screens.capture(), /System Settings/)
  screens.dispose()
})

test('captures are replaced, single-use, discardable, and expire', async (t) => {
  const screens = new ScreenService(port())
  try {
    const first = await screens.capture()
    const second = await screens.capture()
    assert.throws(() => screens.take(first.metadata.id), /expired/)
    assert.equal(screens.take(second.metadata.id).data, DATA)
    assert.throws(() => screens.take(second.metadata.id), /expired/)
    const third = await screens.capture()
    const now = Date.now()
    t.mock.method(Date, 'now', () => now + 61000)
    assert.throws(() => screens.take(third.metadata.id), /expired/)
    t.mock.restoreAll()
    const fourth = await screens.capture()
    screens.clear()
    assert.throws(() => screens.take(fourth.metadata.id), /expired/)
  } finally { screens.dispose() }
})

test('overlapping capture and completion after shutdown are rejected', async () => {
  let resolve!: (value: Awaited<ReturnType<CapturePort['capture']>>) => void
  const screens = new ScreenService({ ...port(), capture: () => new Promise((done) => { resolve = done }) })
  const pending = screens.capture()
  await assert.rejects(screens.capture(), /already/)
  screens.dispose()
  resolve(await port().capture())
  await assert.rejects(pending, /closed/)
})

test('discard during a pending capture invalidates its eventual result', async () => {
  let resolve!: (value: Awaited<ReturnType<CapturePort['capture']>>) => void
  const screens = new ScreenService({ ...port(), capture: () => new Promise((done) => { resolve = done }) })
  try {
    const pending = screens.capture()
    screens.clear()
    resolve(await port().capture())
    await assert.rejects(pending, /discarded/)
    assert.throws(() => screens.take('old-image'), /expired/)
  } finally { screens.dispose() }
})

test('invalid captures fail without leaving a reusable cached image', async () => {
  const screens = new ScreenService({ ...port(), capture: async () => ({ ...await port().capture(), data: '' }) })
  await assert.rejects(screens.capture(), /empty/)
  screens.dispose()
})

test('vision requests attach only the current screenshot and treat its text as untrusted', async () => {
  const screens = new ScreenService(port())
  try {
    const preview = await screens.capture()
    const image = screens.take(preview.metadata.id)
    const gateway = new ClaudeGateway(async (input, init) => {
      const body = await new Request(input, init).json()
      assert.equal(typeof body.messages[0].content, 'string')
      assert.equal(body.messages[2].content[0].source.data, DATA)
      assert.equal(body.messages[2].content[0].source.media_type, 'image/jpeg')
      assert.match(body.messages[2].content[1].text, /Cursor/)
      assert.match(body.system, /untrusted/)
      assert.match(body.system, /unreadable/)
      return Response.json({
        id: 'msg_screen_test', type: 'message', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text: 'A mocked screen explanation.' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    })
    const text = await gateway.reply('unit-test-key-not-real', 'claude-test', [
      { role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Explain this screen' }
    ], new AbortController().signal, image)
    assert.equal(text, 'A mocked screen explanation.')
  } finally { screens.dispose() }
})

test('screen explanations persist metadata and text but never image bytes, including after stop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-screen-'))
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, { available: async () => false, encrypt: async () => Buffer.alloc(0), decrypt: async () => ({ result: '', shouldReEncrypt: false }) })
  await credentials.connect('unit-test-key-not-real', false, [{ id: 'claude-test', label: 'Test' }])
  const screens = new ScreenService(port())
  let resolve!: (text: string) => void
  const coordinator = new AssistantCoordinator({
    history, credentials, screens, changed: () => {},
    gateway: { models: async () => [], reply: async (_key, _model, _messages, _signal, image) => {
      assert.equal(image?.data, DATA)
      return new Promise((done) => { resolve = done })
    } }
  })
  try {
    const preview = await screens.capture()
    const request = coordinator.send({ text: 'Explain my screen', captureId: preview.metadata.id })
    coordinator.stop(request.taskId)
    resolve('This stopped reply must not appear')
    await tick()
    const db = new DatabaseSync(join(directory, 'history.sqlite'))
    const events = db.prepare('SELECT payload_json FROM events').all()
    assert.match(JSON.stringify(events), /capture/)
    assert.ok(!JSON.stringify(events).includes(DATA))
    assert.ok(!JSON.stringify(history.detail(request.conversationId)).includes(DATA))
    assert.equal(history.detail(request.conversationId).messages[0].status, 'stopped')
    assert.throws(() => coordinator.send({ text: 'Reuse screen', captureId: preview.metadata.id }), /expired/)
    db.close()
  } finally { coordinator.dispose(); screens.dispose(); rmSync(directory, { recursive: true, force: true }) }
})
