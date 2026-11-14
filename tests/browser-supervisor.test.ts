import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { BrowserSupervisor } from '../src/main/browser/supervisor.ts'
import { steps, type WorkerCommand } from '../src/shared/flight-contracts.ts'
class Worker extends EventEmitter {
  sent: WorkerCommand[] = []; killed = false
  postMessage(message: WorkerCommand) { this.sent.push(message) }
  kill() { this.killed = true; this.emit('exit', 1); return true }
}
const input = { originAirport: 'SEA', destinationAirport: 'SFO', tripType: 'one_way' as const, departureDate: '2026-12-10', adults: 1 }
function fixture(record = (_type: string, _detail: string) => {}) {
  const worker = new Worker(); const supervisor = new BrowserSupervisor(() => worker, '/tmp/fixture-profile')
  const id = randomUUID(); const controller = new AbortController()
  const result = supervisor.run(id, input, controller.signal, record, () => {})
  return { worker, supervisor, id, controller, result }
}
test('each action is persisted before authorization and outcome saved before the next action', async () => {
  const records: string[] = []; const f = fixture((type) => records.push(type))
  for (const step of steps.filter((s) => s !== 'return')) {
    const actionId = randomUUID()
    f.worker.emit('message', { type: 'action_proposed', taskId: f.id, actionId, step })
    assert.equal(records.at(-1), 'action_pending'); assert.equal(f.worker.sent.at(-1)?.type, 'action_authorized')
    f.worker.emit('message', { type: 'action_result', taskId: f.id, actionId, step, detail: 'Observed fixture state.' })
    assert.equal(records.at(-1), 'action_observed'); assert.equal(f.worker.sent.at(-1)?.type, 'result_saved')
  }
  f.worker.emit('message', { type: 'workflow_result', taskId: f.id, outcome: { status: 'results', detail: 'Visible fixture results.', finalUrl: 'https://www.alaskaair.com/search/results' } })
  assert.equal((await f.result).status, 'results'); assert.equal(f.worker.killed, false)
  f.worker.kill()
})
test('history write failure cannot authorize a side effect', async () => {
  const f = fixture(() => { throw new Error('disk full') })
  f.worker.emit('message', { type: 'action_proposed', taskId: f.id, actionId: randomUUID(), step: 'open_browser' })
  await assert.rejects(f.result)
  assert.equal(f.worker.sent.some((m) => m.type === 'action_authorized'), false)
  assert.equal(f.worker.killed, true)
})
test('out-of-order actions and premature success terminate the worker', async () => {
  for (const message of [ { type: 'action_proposed', step: 'submit', actionId: randomUUID() }, { type: 'workflow_result', outcome: { status: 'results', detail: 'Unverified', finalUrl: '' } } ]) {
    const f = fixture(); f.worker.emit('message', { ...message, taskId: f.id })
    await assert.rejects(f.result); assert.equal(f.worker.killed, true)
  }
})
test('Stop immediately prevents late action authorization and waits for cancellation acknowledgment', async () => {
  const f = fixture(); f.controller.abort()
  f.worker.emit('message', { type: 'action_proposed', taskId: f.id, actionId: randomUUID(), step: 'open_browser' })
  assert.equal(f.worker.sent.some((m) => m.type === 'action_authorized'), false)
  await assert.rejects(f.supervisor.run(randomUUID(), input, new AbortController().signal, () => {}, () => {}), /still stopping/)
  f.worker.emit('message', { type: 'canceled', taskId: f.id })
  await assert.rejects(f.result, /stopped/); f.worker.kill()
})
test('worker exit fails a pending task without replay', async () => {
  const f = fixture(); f.worker.kill(); await assert.rejects(f.result, /exited/)
  assert.equal(f.worker.sent.filter((m) => m.type === 'start').length, 1)
})

test('synchronous worker close does not leave the supervisor permanently closing', async () => {
  const workers: Worker[] = []
  const supervisor = new BrowserSupervisor(() => {
    const worker = new Worker()
    worker.on('close-request', () => worker.emit('exit', 0))
    const post = worker.postMessage.bind(worker)
    worker.postMessage = (message) => { post(message); if (message.type === 'close') worker.emit('close-request') }
    workers.push(worker)
    return worker
  }, '/tmp/fixture-profile')
  for (let i = 0; i < 2; i++) {
    const result = supervisor.run(randomUUID(), input, new AbortController().signal, () => {}, () => {})
    const rejected = assert.rejects(result, /closed|exited/)
    await supervisor.close()
    await rejected
  }
  assert.equal(workers.length, 2)
})

test('hung worker cancellation rejects late actions and reaches its kill deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const rejected = assert.rejects(f.result, /cancellation deadline/)
  f.controller.abort()
  f.worker.emit('message', { type: 'action_result', taskId: f.id, actionId: randomUUID(), step: 'submit', detail: 'Late' })
  assert.equal(f.worker.sent.some((m) => m.type === 'result_saved'), false)
  t.mock.timers.tick(4000)
  await rejected
  assert.equal(f.worker.killed, true)
})

test('close deadline releases a worker even when it never emits exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.worker.kill = () => { f.worker.killed = true; return true }
  const rejected = assert.rejects(f.result)
  const closing = f.supervisor.close()
  assert.equal(f.supervisor.close(), closing)
  await assert.rejects(f.supervisor.run(randomUUID(), input, new AbortController().signal, () => {}, () => {}), /stopping/)
  t.mock.timers.tick(5000)
  await closing; await rejected
  assert.equal(f.worker.killed, true)
  await f.supervisor.close()
})

test('a worker killed without an exit event is never reused for a new search', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const workers: Worker[] = []
  const supervisor = new BrowserSupervisor(() => {
    const worker = new Worker()
    worker.kill = () => { worker.killed = true; return true }
    workers.push(worker)
    return worker
  }, '/tmp/fixture-profile')
  const controller = new AbortController()
  const first = supervisor.run(randomUUID(), input, controller.signal, () => {}, () => {})
  const failed = assert.rejects(first, /cancellation deadline/)
  controller.abort(); t.mock.timers.tick(4000); await failed
  const id = randomUUID()
  const second = supervisor.run(id, input, new AbortController().signal, () => {}, () => {})
  assert.equal(workers.length, 2)
  workers[0].emit('message', { type: 'workflow_result', taskId: id, outcome: { status: 'failed', detail: 'Stale worker', finalUrl: '' } })
  workers[1].emit('message', { type: 'workflow_result', taskId: id, outcome: { status: 'failed', detail: 'New worker', finalUrl: '' } })
  assert.equal((await second).detail, 'New worker')
  const close = supervisor.close(); t.mock.timers.tick(5000); await close
})
