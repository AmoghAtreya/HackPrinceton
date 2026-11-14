import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import type { BrowserRunner } from '../src/main/browser/supervisor.ts'
import type { FlightDraft } from '../src/shared/flight-contracts.ts'
import { localDate } from '../src/main/browser/validation.ts'
import { randomUUID } from 'node:crypto'
async function fixture(browser: BrowserRunner) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-flight-coordinator-'))
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, { available: async () => false, encrypt: async () => { throw new Error() }, decrypt: async () => { throw new Error() } })
  await credentials.connect('fixture-only-not-a-real-provider-key', false, [{ id: 'fixture', label: 'Fixture' }])
  const date = new Date(); date.setDate(date.getDate() + 30)
  let draft: FlightDraft = { originAirport: null, destinationAirport: 'SFO', tripType: 'one_way', departureDate: localDate(date), returnDate: null, adults: 1, unsupportedPassengers: false }
  const coordinator = new AssistantCoordinator({ history, credentials, browser, changed: () => {}, gateway: {
    models: async () => [], reply: async () => '', route: async () => ({ kind: 'flight_search', flight: draft })
  } })
  return { coordinator, history, complete: () => { draft = { ...draft, originAirport: 'SEA' } }, cleanup: () => { coordinator.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}
test('missing details clarify without a browser and a follow-up runs only once', async () => {
  let calls = 0
  const f = await fixture({ close: async () => {}, run: async (_id, input, _signal, record, progress) => {
    calls++; assert.equal(input.originAirport, 'SEA'); record('action_pending', 'Fixture pending'); progress('Fixture progress')
    return { status: 'results', detail: 'Fixture verified results.', finalUrl: 'https://www.alaskaair.com/search/results' }
  } })
  try {
    const task = f.coordinator.send({ text: 'Search Alaska flights' }); await tick()
    assert.equal(calls, 0); assert.match(f.history.detail(task.conversationId).messages.at(-1)!.content, /origin airport/)
    f.complete(); f.coordinator.send({ text: 'SEA', conversationId: task.conversationId }); await tick()
    assert.equal(calls, 1); assert.match(f.history.detail(task.conversationId).messages.at(-1)!.content, /search: results/)
    f.history.detail(task.conversationId); assert.equal(calls, 1, 'Reading history must not execute anything')
  } finally { f.cleanup() }
})
test('Stop aborts browser work and ignores its late outcome', async () => {
  let finish!: (value: { status: 'results'; detail: string; finalUrl: string }) => void; let signal!: AbortSignal
  const f = await fixture({ close: async () => {}, run: async (_id, _input, current) => {
    signal = current; return new Promise((resolve) => { finish = resolve })
  } })
  try {
    f.complete(); const task = f.coordinator.send({ text: 'Search Alaska SEA to SFO' }); await tick()
    f.coordinator.stop(task.taskId); assert.equal(signal.aborted, true)
    finish({ status: 'results', detail: 'Late success', finalUrl: '' }); await tick()
    const saved = f.history.detail(task.conversationId); assert.equal(saved.messages.length, 1); assert.equal(saved.messages[0].status, 'stopped')
  } finally { f.cleanup() }
})

test('Stop after issuing a search preserves its unknown outcome and refuses later activity', async () => {
  let finish!: (value: { status: 'results'; detail: string; finalUrl: string }) => void
  let record!: (type: string, detail: string, data?: object) => void
  const f = await fixture({ close: async () => {}, run: async (_id, _input, _signal, save) => {
    record = save
    save('action_pending', 'Submitting fixture search', { actionId: randomUUID(), step: 'submit' })
    return new Promise((resolve) => { finish = resolve })
  } })
  try {
    f.complete()
    const task = f.coordinator.send({ text: 'Search fixture and stop after submission' }); await tick()
    assert.equal(f.coordinator.snapshot().active?.stage, 'browser')
    f.coordinator.stopActive()
    assert.throws(() => record('action_observed', 'Late result'), /stopped/)
    finish({ status: 'results', detail: 'Late visible results', finalUrl: '' }); await tick()
    const saved = f.history.detail(task.conversationId)
    assert.equal(saved.messages.length, 1)
    assert.equal(saved.messages[0].status, 'stopped')
    assert.ok(saved.activity?.some((event) => event.type === 'action_unknown'))
    assert.ok(!saved.activity?.some((event) => event.type === 'action_observed'))
    f.coordinator.deleteConversation(task.conversationId)
    assert.equal(f.history.list().items.length, 0)
  } finally { f.cleanup() }
})
