import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import type { AssistantRoute } from '../src/shared/flight-contracts.ts'

async function fixture(route: AssistantRoute, openPage?: (url: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-navigation-'))
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, { available: async () => false, encrypt: async () => { throw new Error() }, decrypt: async () => { throw new Error() } })
  await credentials.connect('fixture-only-not-a-real-provider-key', false, [{ id: 'fixture', label: 'Fixture' }])
  const coordinator = new AssistantCoordinator({ history, credentials, changed: () => {}, openPage,
    gateway: { models: async () => [], reply: async () => '', route: async () => route } })
  return { coordinator, history, cleanup: () => { coordinator.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}

test('open_page opens only the listed URL and records the spoken source', async () => {
  const opened: string[] = []
  const f = await fixture({ kind: 'open_page', destination: 'amazon_orders' }, async (url) => { opened.push(url) })
  try {
    const task = f.coordinator.send({ text: 'take me to my amazon orders', source: 'voice' }); await tick(); await tick()
    assert.deepEqual(opened, ['https://www.amazon.com/gp/css/order-history'])
    const detail = f.history.detail(task.conversationId)
    assert.match(detail.messages.at(-1)!.content, /Opening your Amazon orders in your web browser/)
    assert.equal(detail.messages[0].source, 'voice')
  } finally { f.cleanup() }
})

test('a failed browser launch is reported instead of claiming success', async () => {
  const f = await fixture({ kind: 'open_page', destination: 'gmail' }, async () => { throw new Error('no browser') })
  try {
    const task = f.coordinator.send({ text: 'open gmail' }); await tick(); await tick()
    const user = f.history.detail(task.conversationId).messages[0]
    assert.equal(user.status, 'failed')
    assert.match(user.error ?? '', /couldn’t open Gmail/)
  } finally { f.cleanup() }
})

test('a web search without words is refused before anything opens', async () => {
  const opened: string[] = []
  const f = await fixture({ kind: 'open_page', destination: 'web_search' }, async (url) => { opened.push(url) })
  try {
    const task = f.coordinator.send({ text: 'search' }); await tick(); await tick()
    assert.deepEqual(opened, [])
    assert.equal(f.history.detail(task.conversationId).messages[0].status, 'failed')
  } finally { f.cleanup() }
})
