import { app, utilityProcess } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { BrowserSupervisor } from '../../src/main/browser/supervisor.ts'
import { AssistantCoordinator } from '../../src/main/assistant/coordinator.ts'
import { Credentials } from '../../src/main/assistant/credentials.ts'
import { HistoryStore } from '../../src/main/assistant/history.ts'
import { localDate } from '../../src/main/browser/validation.ts'
import type { FlightDraft } from '../../src/shared/flight-contracts.ts'
const root = process.cwd()
const directory = mkdtempSync(join(tmpdir(), 'triage-browser-acceptance-'))
app.setPath('userData', join(directory, 'electron'))
app.whenReady().then(async () => {
  const browser = new BrowserSupervisor(() => utilityProcess.fork(join(root, 'out/main/browser-worker.js'), [], {
    stdio: 'inherit', serviceName: 'Triage browser acceptance',
    env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []))
  }), join(directory, 'browser-profile'))
  const file = join(directory, 'history.sqlite'); const history = new HistoryStore(file)
  const credentials = new Credentials(directory, { available: async () => false, encrypt: async () => { throw new Error() }, decrypt: async () => { throw new Error() } })
  await credentials.connect('fixture-only-not-a-real-provider-key', false, [{ id: 'fixture', label: 'Fixture' }])
  const depart = new Date(); depart.setDate(depart.getDate() + 30)
  const flight: FlightDraft = { originAirport: 'SEA', destinationAirport: 'SFO', tripType: 'one_way', departureDate: localDate(depart), returnDate: null, adults: 1, unsupportedPassengers: false }
  let turn = 0; let stopOnNavigation = false
  const coordinator = new AssistantCoordinator({ history, credentials, browser,
    gateway: { models: async () => [], reply: async () => '', route: async () => ({ kind: 'flight_search', flight: ++turn === 1 ? { ...flight, originAirport: null } : flight }) },
    changed: (state) => {
      if (state.active?.progress) console.log(state.active.progress)
      if (stopOnNavigation && state.active?.progress === 'Opening Alaska Airlines') {
        stopOnNavigation = false
        setTimeout(() => coordinator.stopActive(), 100)
      }
    }
  })
  async function idle(timeout = 180000) {
    const end = Date.now() + timeout
    while (coordinator.snapshot().active && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(coordinator.snapshot().active, null, 'Task exceeded deadline')
  }
  try {
    const first = coordinator.send({ text: 'Search Alaska fixture with missing origin' }); await idle()
    assert.match(history.detail(first.conversationId).messages.at(-1)!.content, /origin airport/)
    coordinator.send({ text: 'Use SEA, please.', conversationId: first.conversationId }); await idle()
    const detail = history.detail(first.conversationId)
    assert.match(detail.messages.at(-1)!.content, /search: results/)
    assert.equal(detail.activity?.filter((e) => e.type === 'action_pending').length, 10)
    assert.equal(detail.activity?.filter((e) => e.type === 'action_observed').length, 10)
    console.log('PASS: clarification → compiled utility worker → visible live results → durable action timeline')
    stopOnNavigation = true
    const canceled = coordinator.send({ text: 'Search again for the cancellation fixture' }); await idle()
    assert.equal(history.detail(canceled.conversationId).messages[0].status, 'stopped')
    assert.ok(history.detail(canceled.conversationId).activity?.some((e) => e.type === 'action_unknown'))
    await browser.close()
    coordinator.dispose()
    const restored = new HistoryStore(file)
    assert.match(restored.detail(first.conversationId).messages.at(-1)!.content, /search: results/)
    restored.close()
    console.log('PASS: cancellation during navigation → browser shutdown → history survives reopen')
  } finally {
    await browser.close(); coordinator.dispose(); rmSync(directory, { recursive: true, force: true })
  }
}).then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1) })
