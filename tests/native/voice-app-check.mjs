// Packaged manual speech/recovery acceptance. Isolated user data, no credentials/model/browser requests.
// Since Phase 10, Finish attempts dispatch; this credential-free runner checks the unsent recovery draft.
// Use --microphone only with explicit authorization; this mode briefly opens real input.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from 'playwright'

const directory = mkdtempSync(join(tmpdir(), 'triage-voice-app-check-'))
const microphone = process.argv.includes('--microphone')
let application
try {
  application = await electron.launch({
    executablePath: resolve('release/Triage.app/Contents/MacOS/Electron'),
    env: { ...process.env, TRIAGE_DATA_DIR: directory, ELECTRON_RENDERER_URL: '' }, timeout: 20000
  })
  await application.firstWindow()
  let page
  for (let attempt = 0; attempt < 100; attempt++) {
    page = application.windows().find((window) => window.url().includes('view=chat'))
    if (page) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(page, 'Packaged chat did not load')
  async function waitVoice(predicate, timeout = 10000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const result = await page.evaluate(() => window.triage.getVoiceState())
      assert.equal(result.ok, true)
      if (predicate(result.value)) return result.value
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Voice state did not reach the expected boundary')
  }
  await page.waitForFunction(() => Boolean(window.triage))
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('view=chat')).show())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Voice settings', exact: true })
  await panel.getByLabel('Enable voice', { exact: true }).waitFor()
  assert.equal(await panel.getByLabel('Enable voice', { exact: true }).isChecked(), false)
  assert.equal(await panel.getByLabel(/Spoken replies/).isDisabled(), true)
  assert.equal(await panel.getByLabel(/Allow voice screen capture/).isDisabled(), true)
  await panel.getByLabel('Enable voice', { exact: true }).check()
  await panel.getByRole('button', { name: 'Save voice settings', exact: true }).click()
  await waitVoice((state) => state.settings.enabled)
  await panel.getByRole('button', { name: 'Set up / Retry permissions', exact: true }).click()
  await waitVoice((state) => state.availability && ['ready', 'error'].includes(state.input), 125000)
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((button) => button.textContent === 'Set up / Retry permissions')?.disabled)
  const setup = await page.evaluate(async () => (await window.triage.getVoiceState()).value)
  assert.equal(setup.sessionId, null)
  console.log(JSON.stringify({ check: 'packaged-setup', input: setup.input, onDevice: setup.availability?.onDevice,
    microphone: setup.availability?.microphone, speech: setup.availability?.speech, notice: setup.notice }))
  if (microphone) {
    assert.equal(setup.input, 'ready', 'Packaged speech setup not accepted')
    if (process.argv.includes('--transcribe')) {
      console.log('Packaged transcription check starts in 3 seconds. Say “Triage voice check” while Listening.')
      await new Promise((resolve) => setTimeout(resolve, 3000))
      await panel.getByRole('button', { name: 'Start talking', exact: true }).click()
      await waitVoice((state) => state.input === 'listening')
      console.log('Listening for 4 seconds now. No audio or transcript will be retained.')
      await new Promise((resolve) => setTimeout(resolve, 4000))
      await panel.getByRole('button', { name: 'Finish and send', exact: true }).click()
      const finished = await waitVoice((state) => !state.sessionId && ['ready', 'error'].includes(state.input))
      console.log(JSON.stringify({ check: 'packaged-final', input: finished.input, nonempty: Boolean(finished.draft.trim()), notice: finished.notice }))
      assert.ok(finished.input === 'ready' && Boolean(finished.draft.trim()), 'Packaged nonempty final transcript not established')
      assert.ok(await panel.getByLabel('Final transcript / recovery draft · unsent', { exact: true }).inputValue() === finished.draft, 'Final transcript not displayed')
      await panel.getByLabel('Final transcript / recovery draft · unsent', { exact: true }).fill('Edited synthetic draft')
      assert.ok(await panel.getByLabel('Final transcript / recovery draft · unsent', { exact: true }).inputValue() === 'Edited synthetic draft')
      console.log('PASS: packaged Finish preserved an unsent recovery draft with microphone released (no model credentials).')
    }
    await panel.getByRole('button', { name: 'Start talking', exact: true }).click()
    await waitVoice((state) => state.input === 'listening')
    await panel.getByRole('button', { name: 'Cancel (Escape)', exact: true }).focus()
    await page.keyboard.press('Escape')
    await waitVoice((state) => state.input === 'ready')
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('view=chat')).isVisible()), true)
    console.log('PASS: focused Escape cancels native input and keeps chat visible.')
    // Confirm leaving Settings cancels input and cannot enqueue assistant work.
    await panel.getByRole('button', { name: 'Set up / Retry permissions', exact: true }).click()
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((button) => button.textContent === 'Set up / Retry permissions')?.disabled)
    await waitVoice((state) => ['ready', 'error'].includes(state.input))
    const retried = await page.evaluate(async () => (await window.triage.getVoiceState()).value)
    assert.equal(retried.input, 'ready', retried.notice)
    assert.ok(retried.availability, retried.notice)
    await panel.getByRole('button', { name: 'Start talking', exact: true }).click()
    await waitVoice((state) => state.input === 'listening')
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await waitVoice((state) => state.input === 'ready')
    await page.getByLabel('Message Triage', { exact: true }).fill('Synthetic typed draft remains usable')
    assert.equal(await page.getByLabel('Message Triage', { exact: true }).inputValue(), 'Synthetic typed draft remains usable')
    console.log('PASS: packaged Start, listening, focused Escape, preserved chat visibility, navigation cancellation, typed draft.')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await panel.getByRole('button', { name: 'Set up / Retry permissions', exact: true }).click()
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((button) => button.textContent === 'Set up / Retry permissions')?.disabled)
    await panel.getByRole('button', { name: 'Start talking', exact: true }).click()
    await waitVoice((state) => state.input === 'listening')
    await panel.getByRole('button', { name: 'Turn off voice', exact: true }).click()
    await waitVoice((state) => state.input === 'disabled')
    console.log('PASS: disabling voice closes active packaged input.')
  }
  const history = await page.evaluate(() => window.triage.listConversations({}))
  assert.equal(history.ok, true); assert.deepEqual(history.value.items, [])
  assert.equal((await page.evaluate(() => window.triage.getAssistantState())).value.active, null)
  const preferences = JSON.parse(readFileSync(join(directory, 'voice-settings.json'), 'utf8'))
  assert.deepEqual(Object.keys(preferences).sort(), ['enabled', 'microphoneId', 'shortcut', 'spokenReplies', 'allowScreenCapture'].sort())
  console.log('PASS: credential-free speech recovery creates no assistant task/history; preferences contain no transcripts.')
} finally {
  await application?.close()
  rmSync(directory, { recursive: true, force: true })
}
