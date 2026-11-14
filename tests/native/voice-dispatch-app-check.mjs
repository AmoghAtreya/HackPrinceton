// Run after npm run build, with owner authorization. No real microphone,
// credentials, screenshots, network requests or provider calls are used.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron } from 'playwright'

const directory = mkdtempSync(join(tmpdir(), 'triage-voice-dispatch-ui-'))
const bundle = resolve('out/main/voice-dispatch-fixture.cjs')
let application
try {
  await build({ entryPoints: ['tests/native/voice-dispatch-main.ts'], outfile: bundle,
    platform: 'node', format: 'cjs', bundle: true, packages: 'external' })
  const env = { ...process.env, TRIAGE_DATA_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ args: [bundle], env, timeout: 20000 })
  const page = await application.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Voice settings', exact: true })
  await settings.getByLabel('Enable voice', { exact: true }).check()
  await settings.getByRole('button', { name: 'Save voice settings', exact: true }).click()
  await settings.getByRole('button', { name: 'Set up / Retry permissions', exact: true }).click()
  await settings.getByRole('button', { name: 'Start talking', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.locator('.voice-chat-controls > summary').click()
  const panel = page.getByRole('region', { name: 'Voice input', exact: true })
  async function waitVoice(predicate) {
    const end = Date.now() + 5000
    while (Date.now() < end) {
      const state = await application.evaluate(() => globalThis.voiceFixture.state())
      if (predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw Error('Expected voice boundary not reached')
  }
  async function start(text) {
    await application.evaluate((_electron, value) => globalThis.voiceFixture.final(value), text)
    await panel.getByRole('button', { name: 'Start talking', exact: true }).click()
    await waitVoice((state) => state.input === 'listening')
  }
  async function say(text) {
    await start(text)
    await panel.getByRole('button', { name: 'Finish and send', exact: true }).click()
    return waitVoice((state) => !state.sessionId)
  }
  await page.locator('#message').fill('Preserve my typed draft')
  await start('Fixture question')
  await page.locator('.voice-chat-controls > summary').click()
  await page.waitForFunction(() => document.querySelector('.voice-chat-controls').open)
  await page.locator('#message').press('Enter')
  await page.getByRole('alert').filter({ hasText: 'Finish or cancel voice input first' }).waitFor()
  assert.equal(await page.locator('#message').inputValue(), 'Preserve my typed draft')
  assert.equal((await application.evaluate(() => globalThis.voiceFixture.contexts())).length, 0)
  await panel.getByRole('button', { name: 'Finish and send', exact: true }).click()
  await page.getByText('Which date?', { exact: true }).waitFor()
  const first = await waitVoice((state) => Boolean(state.receipt))
  assert.equal(await page.locator('#message').inputValue(), 'Preserve my typed draft')
  await say('December twelfth')
  await page.getByText('Fixture answer received', { exact: true }).waitFor()
  assert.equal((await waitVoice(() => true)).receipt.conversationId, first.receipt.conversationId)
  assert.equal(await page.getByText('You · voice', { exact: true }).count(), 2)
  const contexts = await application.evaluate(() => globalThis.voiceFixture.contexts())
  assert.deepEqual(contexts[1].map((turn) => turn.content), ['Fixture question', 'Which date?', 'December twelfth'])
  console.log('PASS: compiled chat/preload/IPC voice dispatch, exactly-once finals, follow-up context, typed draft preservation.')

  await say('Hold fixture task')
  await page.getByRole('button', { name: '■ Stop', exact: true }).waitFor()
  const busy = await say('Do not queue this request')
  assert.match(busy.notice, /still working/)
  assert.equal((await application.evaluate(() => globalThis.voiceFixture.contexts())).length, 3)
  await say('Stop!')
  await application.evaluate(() => globalThis.voiceFixture.late())
  await page.getByText('stopped: Stopped by you. No later reply will be added.', { exact: true }).waitFor()
  assert.equal(await page.getByText('Late result must be suppressed', { exact: true }).count(), 0)
  const screen = await say('Explain this screen')
  assert.match(screen.notice, /No screenshot was taken/)
  assert.equal((await application.evaluate(() => globalThis.voiceFixture.contexts())).length, 3)
  console.log('PASS: busy rejection, local Stop, suppressed late reply, deferred screen capture.')

  await start('Cancelled by new chat')
  const captured = (await waitVoice(() => true)).sessionId
  await page.getByRole('button', { name: 'Start a new conversation' }).click()
  await waitVoice((state) => !state.sessionId)
  await application.evaluate((_electron, id) => globalThis.voiceFixture.stale(id), captured)
  assert.equal((await application.evaluate(() => globalThis.voiceFixture.contexts())).length, 3)
  await panel.getByRole('button', { name: 'Set up / Retry permissions', exact: true }).click()
  await waitVoice((state) => state.availability && state.input === 'ready')
  await say('New conversation fixture')
  await page.locator('.user-message').getByText('New conversation fixture', { exact: true }).waitFor()
  const latest = await waitVoice(() => true)
  assert.notEqual(latest.receipt.conversationId, first.receipt.conversationId)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.locator('.history-open').filter({ hasText: 'Fixture question' }).click()
  assert.equal((await waitVoice(() => true)).conversationId, first.receipt.conversationId)
  await page.locator('.voice-chat-controls > summary').click()
  await say('Follow-up after explicit selection')
  assert.equal((await waitVoice(() => true)).receipt.conversationId, first.receipt.conversationId)
  const saved = await page.evaluate(async () => (await window.triage.getConversation({ id: (await window.triage.getVoiceState()).value.conversationId })).value)
  assert.ok(saved.messages.filter((message) => message.role === 'user').every((message) => message.source === 'voice'))
  assert.ok(!JSON.stringify(saved).includes('Synthetic provisional'))
  assert.equal(await page.getByRole('alert').count(), 0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await application.evaluate(() => globalThis.voiceFixture.final('turn off voice'))
  await settings.getByRole('button', { name: 'Start talking', exact: true }).click()
  await waitVoice((state) => state.input === 'listening')
  await settings.getByRole('button', { name: 'Finish and send', exact: true }).click()
  await waitVoice((state) => state.input === 'disabled')
  await page.waitForFunction(() => document.querySelector('.voice-settings .checkbox-label input')?.checked === false)
  assert.equal(await settings.getByLabel('Enable voice', { exact: true }).isChecked(), false)
  assert.deepEqual(errors, [])
  console.log('PASS: spoken disable keeps saved preference and settings checkbox synchronized.')
  console.log('PASS: New chat cancels recording, fresh conversation, explicit history selection, visible voice source, no partial persistence.')
} finally {
  await application?.close()
  rmSync(bundle, { force: true })
  rmSync(directory, { recursive: true, force: true })
}
