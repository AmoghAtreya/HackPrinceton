// Owner-coordinated, real global keys and on-device speech; isolated packaged
// profile, no API credentials/provider requests. Never prints or retains speech.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const directory = mkdtempSync(join(tmpdir(), 'triage-hold-acceptance-'))
let application
try {
  const env = { ...process.env, TRIAGE_DATA_DIR: directory, ELECTRON_RENDERER_URL: '' }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ executablePath: resolve('release/Triage.app/Contents/MacOS/Electron'), env, timeout: 20000 })
  let page
  for (let n = 0; n < 100; n++) {
    page = application.windows().find((window) => window.url().includes('view=chat'))
    if (page) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(page, 'Packaged chat loaded')
  await page.waitForFunction(() => Boolean(window.triage))
  const state = async () => {
    const result = await page.evaluate(() => window.triage.getVoiceState())
    assert.equal(result.ok, true)
    return result.value
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=chat')).show())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Voice settings', exact: true })
  await page.evaluate(async () => {
    const current = await window.triage.getVoiceState()
    const saved = await window.triage.saveVoiceSettings({ ...current.value.settings, enabled: true })
    if (!saved.ok) throw Error(saved.error.message)
  })
  console.log('SETUP: allow Microphone, Speech Recognition and Input Monitoring for Triage Voice Helper if macOS asks. Click-to-talk stays available if global access is denied.')
  await page.evaluate(async () => {
    const result = await window.triage.setupVoice()
    if (!result.ok) throw Error(result.error.message)
  })
  let ready
  const setupDeadline = Date.now() + 150000
  while (Date.now() < setupDeadline) {
    ready = await state()
    if (ready.input === 'ready' && ready.availability && ready.shortcut?.status === 'registered') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(ready.shortcut?.status, 'registered', 'Global shortcut requires Input Monitoring; retry setup after granting it')
  assert.equal(ready.input, 'ready')
  const builtIn = ready.availability.devices.find((device) => device.id === 'BuiltInMicrophoneDevice')
  if (builtIn) {
    await page.evaluate(async (microphoneId) => {
      const current = await window.triage.getVoiceState()
      const saved = await window.triage.saveVoiceSettings({ ...current.value.settings, microphoneId })
      if (!saved.ok) throw Error(saved.error.message)
    }, builtIn.id)
    // The production shortcut controller warms speech again after teardown.
    // Await that existing operation instead of starting a competing setup.
    await page.waitForFunction(async () => {
      const result = await window.triage.getVoiceState()
      return result.ok && result.value.input === 'ready' && result.value.availability?.available
    }, undefined, { timeout: 15000 })
    console.log('MICROPHONE: using the enumerated built-in microphone for this isolated test profile.')
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('view=chat')).hide())
  if (process.env.TRIAGE_HOLD_READY_FILE) {
    console.log('SETUP READY: native speech and shortcut ready; waiting for the owner go signal before starting the physical test window.')
    const goDeadline = Date.now() + 300000
    while (!existsSync(process.env.TRIAGE_HOLD_READY_FILE) && Date.now() < goDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(existsSync(process.env.TRIAGE_HOLD_READY_FILE), 'Owner go signal is required')
  }
  console.log('READY: from another app hold Control+Option+Space, wait for Listening, say “What is a layover?”, keep holding until Finder comes forward automatically, then release. You have 180 seconds. No assistant/provider request will run.')
  const front = () => execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', timeout: 1000 }).trim()
  let initialFront = ''
  let changedWhileHeld = false
  let listeningWithoutFocus = false
  let captureId = null
  let finalizing = false
  let switched = false
  let accepted = false
  const deadline = Date.now() + 180000
  let previousInput = ''
  let activations = 0
  let audioLevelObserved = false
  let provisionalObserved = false
  while (Date.now() < deadline) {
    const current = await state()
    if (current.input !== previousInput) {
      previousInput = current.input
      console.log(JSON.stringify({ check: 'physical-state', input: current.input, hasSession: Boolean(current.sessionId), hasDraft: Boolean(current.draft), ...(current.input === 'error' ? { notice: current.notice } : {}) }))
    }
    if (current.sessionId && current.sessionId !== captureId) {
      activations++
      captureId = current.sessionId; initialFront = front(); changedWhileHeld = false; finalizing = false
    }
    audioLevelObserved ||= current.level > 0.01
    provisionalObserved ||= Boolean(current.provisional)
    if (current.input === 'error' && activations) {
      console.log(JSON.stringify({ check: 'physical-failure', changedWhileHeld, listeningWithoutFocus, audioLevelObserved, provisionalObserved }))
      throw Error(current.notice)
    }
    if (current.sessionId && current.input === 'listening') {
      if (!switched) {
        switched = true
        execFileSync('/usr/bin/open', ['-a', 'Finder'], { timeout: 3000 })
      }
      if (front() !== initialFront) changedWhileHeld = true
      listeningWithoutFocus ||= await application.evaluate(({ BrowserWindow }) => !BrowserWindow.getFocusedWindow())
    }
    if (current.input === 'finalizing' && current.sessionId) finalizing = true
    if (captureId && !current.sessionId && current.input === 'ready' && current.draft.trim()) {
      assert.ok(finalizing, 'Release entered bounded finalization')
      assert.ok(changedWhileHeld, 'Foreground changed during actual speech capture')
      assert.ok(listeningWithoutFocus, 'Voice status did not focus Triage')
      assert.match(current.notice, /key|connect/i, 'No credentials means an unsent recovery draft, not a live request')
      accepted = true; break
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  assert.ok(accepted, `Physical hold/speak/focus-change/release must produce a nonempty final (${activations} activations observed)`)
  const final = await state()
  assert.equal(final.sessionId, null)
  assert.equal(final.provisional, '')
  const list = await page.evaluate(() => window.triage.listConversations())
  assert.ok(list.ok && list.value.items.length === 0, 'Credential-free check creates no history')
  const voiceWindow = application.windows().find((window) => window.url().includes('view=voice'))
  assert.ok(voiceWindow)
  await voiceWindow.getByRole('button', { name: 'Stop', exact: true }).click()
  const denied = await voiceWindow.evaluate(() => window.triage.startVoice())
  assert.ok(!denied.ok && denied.error.code === 'untrusted', 'Status window cannot start microphone input')
  await page.evaluate(async () => {
    const result = await window.triage.getVoiceState()
    return window.triage.saveVoiceSettings({ ...result.value.settings, enabled: false })
  })
  console.log('PASS: production packaged hold → local speech → foreground change → release → nonempty final; nonfocus status/Stop, no task/history, stream cleanup and restricted status IPC.')
} finally {
  if (application) await application.close()
  rmSync(directory, { recursive: true, force: true })
}
