import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { AppProblem } from '../src/main/assistant/errors.ts'
import { writeFileSync } from 'node:fs'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'triage-history-'))
  const file = join(directory, 'history.sqlite')
  return { file, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('completed messages and failed outcomes survive restart without replay', () => {
  const f = fixture()
  let store = new HistoryStore(f.file)
  try {
    const first = store.begin('Remember my project name: Triage.', 'claude-test')
    store.complete(first.taskId, 'Your project is Triage.')
    const failed = store.begin('A failed follow-up', 'claude-test', first.conversationId)
    store.finish(failed.taskId, 'failed', 'Provider unavailable.')
    store.close()
    store = new HistoryStore(f.file)
    const detail = store.detail(first.conversationId)
    assert.deepEqual(detail.messages.map((m) => m.content), [
      'Remember my project name: Triage.', 'Your project is Triage.', 'A failed follow-up'
    ])
    assert.equal(detail.messages.at(-1)?.status, 'failed')
    assert.equal(detail.messages.at(-1)?.error, 'Provider unavailable.')
    const next = store.begin('What was the name?', 'claude-test', first.conversationId)
    const context = store.context(first.conversationId, next.taskId)
    assert.deepEqual(context.map((turn) => turn.content), [
      'Remember my project name: Triage.', 'Your project is Triage.', 'What was the name?'
    ])
  } finally { store.close(); f.cleanup() }
})

test('unfinished tasks become interrupted and canceled tasks reject late completion', () => {
  const f = fixture()
  let store = new HistoryStore(f.file)
  try {
    const unfinished = store.begin('Pending request', 'claude-test')
    const stopped = store.begin('Stop this one', 'claude-test')
    store.finish(stopped.taskId, 'stopped', 'Stopped by you.')
    assert.equal(store.complete(stopped.taskId, 'A late reply must not appear.'), false)
    store.close()
    store = new HistoryStore(f.file)
    assert.equal(store.detail(unfinished.conversationId).messages[0].status, 'interrupted')
    assert.equal(store.detail(stopped.conversationId).messages.length, 1)
    const db = new DatabaseSync(f.file)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM events WHERE type=?').get('request_interrupted') as {n:number}).n, 1)
    db.close()
  } finally { store.close(); f.cleanup() }
})

test('history and message pagination do not drop or duplicate records', () => {
  const f = fixture()
  const store = new HistoryStore(f.file)
  try {
    const ids = new Set<string>()
    for (let i = 0; i < 28; i++) {
      const request = store.begin('Conversation ' + i, 'claude-test')
      store.finish(request.taskId, 'stopped')
      ids.add(request.conversationId)
    }
    const first = store.list()
    assert.ok(first.next)
    const second = store.list(first.next!)
    const listed = [...first.items, ...second.items].map((item) => item.id)
    assert.equal(listed.length, ids.size)
    assert.deepEqual(new Set(listed), ids)
    assert.equal(second.next, null)
    const long = store.begin('Turn 0', 'claude-test')
    store.complete(long.taskId, 'Reply 0')
    for (let i = 1; i < 55; i++) {
      const request = store.begin('Turn ' + i, 'claude-test', long.conversationId)
      store.complete(request.taskId, 'Reply ' + i)
    }
    const latest = store.detail(long.conversationId)
    assert.ok(latest.nextBefore)
    const earlier = store.detail(long.conversationId, latest.nextBefore!)
    const all = [...earlier.messages, ...latest.messages]
    assert.equal(all.length, 110)
    assert.equal(new Set(all.map((m) => m.id)).size, 110)
    assert.equal(all[0].content, 'Turn 0')
    assert.equal(earlier.nextBefore, null)
    const pending = store.begin('Latest follow-up', 'claude-test', long.conversationId)
    const context = store.context(long.conversationId, pending.taskId)
    assert.ok(context.length <= 20)
    assert.ok(context.reduce((sum, m) => sum + m.content.length, 0) <= 24000)
    assert.equal(context[0].role, 'user')
    assert.equal(context.at(-1)?.content, 'Latest follow-up')
  } finally { store.close(); f.cleanup() }
})

test('deletion cascades through messages tasks and events and secrets are redacted', () => {
  const f = fixture()
  const store = new HistoryStore(f.file)
  try {
    const fake = 'sk-ant-unit-test-not-a-real-credential'
    const request = store.begin('api_key=' + fake, 'claude-test')
    store.complete(request.taskId, 'password=hunter-test-only')
    assert.ok(!JSON.stringify(store.detail(request.conversationId)).includes(fake))
    assert.ok(!JSON.stringify(store.detail(request.conversationId)).includes('hunter-test-only'))
    store.delete(request.conversationId)
    const db = new DatabaseSync(f.file)
    for (const table of ['conversations', 'messages', 'tasks', 'events']) {
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as {n:number}).n, 0)
    }
    db.close()
    const another = store.begin('Disposable request', 'claude-test')
    store.clear()
    assert.equal(store.list().items.length, 0)
    assert.throws(() => store.summary(another.conversationId))
  } finally { store.close(); f.cleanup() }
})

test('activity persists only validated public metadata and strips sensitive URL fields', () => {
  const f = fixture(); const store = new HistoryStore(f.file)
  try {
    const request = store.begin('Privacy fixture', 'fixture')
    store.activity(request.taskId, 'flight_outcome', 'Observed fixture', {
      html: '<private-page/>', cookies: 'private-cookie', screenshot: 'private-image', headers: { authorization: 'private-token' },
      outcome: { status: 'results', detail: 'password=private-password', html: 'private-nested-html',
        finalUrl: 'https://www.alaskaair.com/search/results?O=SEA&D=SFO&OD=2026-12-10&A=1&RT=false&token=private-token#private-fragment' }
    })
    const db = new DatabaseSync(f.file)
    try {
      const row = db.prepare("SELECT payload_json FROM events WHERE type='flight_outcome'").get() as { payload_json: string }
      assert.ok(!row.payload_json.includes('private-'))
      const payload = JSON.parse(row.payload_json)
      assert.deepEqual(Object.keys(payload).sort(), ['detail', 'outcome'])
      assert.equal(payload.outcome.finalUrl, 'https://www.alaskaair.com/search/results?O=SEA&D=SFO&OD=2026-12-10&A=1&RT=false')
      assert.equal(payload.outcome.detail, 'password=[redacted]')
    } finally { db.close() }
  } finally { store.close(); f.cleanup() }
})

test('a locked database rolls back atomically and can recover after the lock releases', () => {
  const f = fixture(); const store = new HistoryStore(f.file); const blocker = new DatabaseSync(f.file)
  try {
    blocker.exec('BEGIN IMMEDIATE')
    assert.throws(() => store.begin('Never partially saved', 'fixture'), (error) => error instanceof AppProblem && error.code === 'storage')
    assert.equal(store.list().items.length, 0)
    blocker.exec('ROLLBACK')
    const request = store.begin('Saved after recovery', 'fixture')
    assert.equal(store.detail(request.conversationId).messages.length, 1)
    store.close(); store.close()
  } finally { blocker.close(); store.close(); f.cleanup() }
})

test('invalid databases and invalid parent paths return actionable storage errors', () => {
  const f = fixture()
  try {
    writeFileSync(f.file, 'invalid database fixture')
    for (const file of [f.file, join(f.file, 'history.sqlite')]) {
      assert.throws(() => new HistoryStore(file), (error) => error instanceof AppProblem && error.code === 'storage' && /disk access/.test(error.message))
    }
  } finally { f.cleanup() }
})
