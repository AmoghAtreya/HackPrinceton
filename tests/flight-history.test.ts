import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HistoryStore } from '../src/main/assistant/history.ts'
test('browser pending actions recover as unknown without replay and cascade on deletion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-flight-history-')); const file = join(directory, 'history.sqlite')
  let store = new HistoryStore(file)
  try {
    const task = store.begin('Search fixture', 'fixture'); const actionId = randomUUID()
    store.activity(task.taskId, 'flight_clarification', 'Which airport?')
    assert.equal(store.clarificationParent(task.conversationId), task.taskId)
    store.activity(task.taskId, 'action_pending', 'Submitting fixture', { actionId, step: 'submit' }); store.close()
    store = new HistoryStore(file)
    const detail = store.detail(task.conversationId)
    assert.equal(detail.messages[0].status, 'interrupted')
    assert.equal(detail.activity?.filter((e) => e.type === 'action_unknown').length, 1)
    store.delete(task.conversationId); assert.equal(store.list().items.length, 0)
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
test('observed actions stay observed while stopped and failed actions record unknown outcomes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-flight-events-')); const store = new HistoryStore(join(directory, 'history.sqlite'))
  try {
    for (const status of ['stopped', 'failed', 'completed'] as const) {
      const task = store.begin('Fixture', 'fixture'); const observed = randomUUID(); const pending = randomUUID()
      store.activity(task.taskId, 'action_pending', 'First', { actionId: observed })
      store.activity(task.taskId, 'action_observed', 'Verified first', { actionId: observed })
      store.activity(task.taskId, 'action_pending', 'Second', { actionId: pending })
      if (status === 'completed') store.complete(task.taskId, 'Workflow failed; cannot verify the last action.')
      else store.finish(task.taskId, status, 'Stopped or failed')
      assert.equal(store.detail(task.conversationId).activity?.filter((e) => e.type === 'action_unknown').length, 1)
      assert.throws(() => store.activity(task.taskId, 'action_pending', 'Late'), /no longer active/)
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
