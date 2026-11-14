import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { LocalRequestLog, type FinishedRequest } from '../src/main/logging/request-log.ts'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'

const request: FinishedRequest = { at: 1, source: 'voice', text: 'open gmail', outcome: 'completed', latencyMs: 5, route: 'open_page', destination: 'gmail' }

test('nothing is logged until the user opts in, and deleting rotates the anonymous id', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-request-log-'))
  try {
    const log = new LocalRequestLog(directory, '0.1.0')
    log.record(request)
    assert.equal(existsSync(log.outboxFile), false)
    assert.deepEqual(log.snapshot(), { shareRequests: false, pending: 0 })
    log.save({ shareRequests: true })
    log.record(request); log.record({ ...request, text: 'x'.repeat(5000) })
    const reopened = new LocalRequestLog(directory, '0.1.0')
    assert.deepEqual(reopened.snapshot(), { shareRequests: true, pending: 2 })
    const lines = readFileSync(log.outboxFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines[0].destination, 'gmail')
    assert.equal(lines[1].text.length, 1000)
    const firstId = lines[0].installId
    assert.equal(lines[1].installId, firstId)
    reopened.clear()
    assert.equal(existsSync(log.outboxFile), false)
    reopened.record(request)
    const after = JSON.parse(readFileSync(log.outboxFile, 'utf8').trim())
    assert.notEqual(after.installId, firstId)
    assert.throws(() => reopened.save({ shareRequests: 'yes' }), { code: 'invalid_input' })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('the coordinator reports finished requests with route, source and outcome', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-request-log-coordinator-'))
  const recorded: FinishedRequest[] = []
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, { available: async () => false, encrypt: async () => { throw new Error() }, decrypt: async () => { throw new Error() } })
  await credentials.connect('fixture-only-not-a-real-provider-key', false, [{ id: 'fixture', label: 'Fixture' }])
  const coordinator = new AssistantCoordinator({ history, credentials, changed: () => {}, requestLog: { record: (event) => recorded.push(event) },
    openPage: async () => { throw new Error('no browser') },
    gateway: { models: async () => [], reply: async () => '', route: async () => ({ kind: 'open_page', destination: 'gmail' }) } })
  try {
    coordinator.send({ text: 'open gmail please', source: 'voice' }); await tick(); await tick()
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].source, 'voice')
    assert.equal(recorded[0].route, 'open_page')
    assert.equal(recorded[0].destination, 'gmail')
    assert.equal(recorded[0].outcome, 'failed')
    assert.match(recorded[0].error ?? '', /couldn’t open Gmail/)
    assert.equal(recorded[0].text, 'open gmail please')
  } finally { coordinator.dispose(); rmSync(directory, { recursive: true, force: true }) }
})
