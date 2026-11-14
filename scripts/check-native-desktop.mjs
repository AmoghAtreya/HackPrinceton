import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { _electron as electron } from 'playwright'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { DatabaseSync } from 'node:sqlite'

// Run after npm run build. Only disposable fixture conversations enter this app.
// No real credentials, screenshots, or provider requests are used.
if (process.platform !== 'darwin') throw new Error('Run this desktop acceptance check on macOS.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packaged = process.argv.includes('--packaged')
const directory = mkdtempSync(join(tmpdir(), 'triage-desktop-acceptance-'))
const file = join(directory, 'history.sqlite')
let desktop
const failures = []
async function launch() {
  const env = { ...process.env, TRIAGE_DATA_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  desktop = await electron.launch({
    executablePath: join(root, packaged ? 'release/Triage.app/Contents/MacOS/Electron' : 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: packaged ? [] : [join(root, 'out/main/index.js')], env, timeout: 20000
  })
  const end = Date.now() + 15000
  while (!desktop.windows().some((page) => page.url().includes('view=chat'))) {
    if (Date.now() > end) throw new Error('Chat renderer did not initialize.')
    await new Promise((done) => setTimeout(done, 50))
  }
  const chat = desktop.windows().find((page) => page.url().includes('view=chat'))
  chat.on('pageerror', (error) => failures.push(error.message))
  await chat.getByRole('button', { name: 'History', exact: true }).waitFor()
  await chat.evaluate(() => window.triage.toggleChat())
  return chat
}
async function quit() {
  if (!desktop) return
  const instance = desktop
  const process = instance.process()
  desktop = undefined
  await instance.close()
  assert.equal(process.exitCode, 0, 'Desktop shutdown must finish normally')
}
async function history(chat, count) {
  await chat.getByRole('button', { name: 'History', exact: true }).click()
  await chat.waitForFunction(() => document.querySelectorAll('.history-card').length === 25)
  await chat.getByRole('button', { name: 'Load older conversations' }).click()
  await chat.waitForFunction((n) => document.querySelectorAll('.history-card').length === n, count)
}

try {
  const seed = new HistoryStore(file)
  for (let n = 0; n < 30; n++) {
    const receipt = seed.begin('Archive fixture ' + n, 'fixture')
    seed.complete(receipt.taskId, 'Saved fixture reply ' + n)
  }
  const long = seed.begin('Long conversation fixture', 'fixture')
  seed.complete(long.taskId, 'Reply zero')
  for (let n = 1; n < 110; n++) {
    const receipt = seed.begin('Older turn ' + n, 'fixture', long.conversationId)
    seed.activity(receipt.taskId, 'request_status', 'Thinking…', { stage: 'thinking' })
    seed.complete(receipt.taskId, 'Reply ' + n)
  }
  const interrupted = seed.begin('Interrupted browser fixture', 'fixture')
  seed.activity(interrupted.taskId, 'action_pending', 'Submitting fixture search', { actionId: randomUUID(), step: 'submit' })
  seed.close()

  let chat = await launch()
  await history(chat, 32)
  await chat.locator('.history-open').filter({ hasText: 'Interrupted browser fixture' }).click()
  await chat.getByText('interrupted:', { exact: false }).waitFor()
  await chat.getByText('Saved action timeline', { exact: true }).click()
  await chat.getByText('Outcome unknown:', { exact: false }).waitFor()
  const retry = chat.getByRole('button', { name: 'Use this message again' })
  await retry.click()
  assert.equal(await chat.locator('#message').inputValue(), 'Interrupted browser fixture')
  assert.equal(await chat.getByRole('button', { name: '■ Stop' }).count(), 0)
  console.log('PASS: compiled app recovers interrupted tasks and unknown actions without replay')

  await chat.getByRole('button', { name: 'History', exact: true }).click()
  await chat.locator('.history-open').filter({ hasText: 'Long conversation fixture' }).click()
  await chat.waitForFunction(() => document.querySelectorAll('.user-message,.assistant-message').length === 100)
  await chat.getByRole('button', { name: 'Load earlier messages' }).click()
  await chat.waitForFunction(() => document.querySelectorAll('.user-message,.assistant-message').length === 200)
  await chat.getByRole('button', { name: 'Load earlier messages' }).click()
  await chat.waitForFunction(() => document.querySelectorAll('.user-message,.assistant-message').length === 220)
  await chat.getByText('Saved action timeline', { exact: true }).click()
  await chat.getByRole('button', { name: 'Load earlier activity' }).click()
  await chat.waitForFunction(() => document.querySelectorAll('.activity-timeline li').length === 329)
  console.log('PASS: all message and activity pages are reviewable for a text conversation')

  await chat.getByRole('button', { name: 'Settings', exact: true }).click()
  await chat.getByLabel('Anthropic API key', { exact: true }).waitFor()
  assert.equal(await chat.getByLabel('Anthropic API key', { exact: true }).inputValue(), '')
  await chat.getByRole('button', { name: 'Hide Triage', exact: true }).click()
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())), false)
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((item) => item.label === 'Open chat').click())
  await chat.getByLabel('Anthropic API key', { exact: true }).waitFor({ state: 'visible' })
  const before = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('view=companion')).getPosition())
  const companion = desktop.windows().find((page) => page.url().includes('view=companion'))
  await companion.evaluate(() => { window.triage.beginDrag({ x: 200, y: 200 }); window.triage.endDrag(true, { x: 150, y: 200 }) })
  await chat.waitForTimeout(100)
  const after = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('view=companion')).getPosition())
  assert.equal(after[0], before[0] - 50)
  console.log('PASS: key-free settings, hide/menu restore, and native character movement')

  // Exercise the actual SDK and renderer IPC with HTTP responses confined to
  // this test process. Never send the fixture key or messages over the network.
  await desktop.evaluate(() => {
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== 'https://api.anthropic.com') throw new Error('Unexpected fixture endpoint')
      if (url.pathname === '/v1/models') return Response.json({
        data: [{ id: 'claude-fixture', display_name: 'Fixture Claude', type: 'model', created_at: '2026-01-01T00:00:00Z' }],
        has_more: false, first_id: 'claude-fixture', last_id: 'claude-fixture'
      })
      if (url.pathname !== '/v1/messages') throw new Error('Unexpected fixture operation')
      const body = await request.json()
      const latest = body.messages.at(-1).content
      if (Array.isArray(latest)) return Response.json({
        id: 'msg_screen_fixture', type: 'message', role: 'assistant', model: 'claude-fixture',
        content: [{ type: 'text', text: body.output_config ? JSON.stringify({ explanation: 'Synthetic target fixture.', target: { x1: 100, y1: 100, x2: 180, y2: 160 } }) : 'Synthetic screen fixture explanation.' }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }
      })
      if (latest.startsWith('Hold')) return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (request.signal.aborted) abort()
        else request.signal.addEventListener('abort', abort, { once: true })
      })
      if (latest === 'Fail the network fixture') return Response.json({ type: 'error', error: { type: 'api_error', message: 'private-raw-fixture-error' } }, { status: 503 })
      return Response.json({
        id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture',
        content: [{ type: 'text', text: JSON.stringify({ kind: 'reply', text: `Fixture context received (${body.messages.length} turns).` }) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }
      })
    }
  })
  await chat.evaluate(() => window.triage.toggleChat())
  await chat.getByLabel('Anthropic API key', { exact: true }).fill('fixture-only-not-a-real-provider-key')
  await chat.getByRole('button', { name: 'Connect key', exact: true }).click()
  await chat.getByText('Connected. Choose a model below, then return to Chat.', { exact: true }).waitFor()
  await chat.getByRole('button', { name: 'Start a new conversation' }).click()
  async function send(text) {
    await chat.locator('#message').fill(text)
    await chat.locator('#message').press('Enter')
  }
  await send('Desktop SDK fixture conversation')
  await chat.getByText('Fixture context received (1 turns).', { exact: true }).waitFor()
  await send('Follow up using the earlier context')
  await chat.getByText('Fixture context received (3 turns).', { exact: true }).waitFor()

  // Replace only native capture inputs: the production capture service, hiding,
  // renderer preview, SDK image payload, metadata persistence, and overlay run.
  await desktop.evaluate(({ desktopCapturer, systemPreferences, nativeImage, screen }) => {
    const display = screen.getPrimaryDisplay()
    screen.getCursorScreenPoint = () => ({ x: display.bounds.x + 300, y: display.bounds.y + 300 })
    systemPreferences.getMediaAccessStatus = () => 'denied'
    desktopCapturer.getSources = async () => [{
      id: 'screen:fixture', name: 'Synthetic fixture', display_id: String(display.id),
      thumbnail: nativeImage.createFromBitmap(Buffer.alloc(1280 * 800 * 4, 255), { width: 1280, height: 800 })
    }]
  })
  await chat.getByRole('button', { name: 'Capture screen', exact: true }).click()
  await chat.getByRole('alert').filter({ hasText: 'macOS reports screen access as denied' }).waitFor()
  await desktop.evaluate(({ systemPreferences }) => { systemPreferences.getMediaAccessStatus = () => 'granted' })
  await chat.getByRole('button', { name: 'Capture screen', exact: true }).click()
  await chat.getByAltText('Current display screenshot preview').waitFor()
  await send('Explain the synthetic screen')
  await chat.getByText('Synthetic screen fixture explanation.', { exact: true }).waitFor()
  await chat.getByRole('button', { name: 'Capture screen', exact: true }).click()
  await chat.getByAltText('Current display screenshot preview').waitFor()
  await chat.getByLabel('Show me where to click', { exact: true }).check()
  await send('Locate the synthetic control')
  await chat.getByText('Synthetic target fixture.', { exact: true }).waitFor()
  await chat.getByRole('button', { name: 'Dismiss highlight', exact: true }).waitFor()
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('view=highlight')).isFocusable()), false)
  await chat.getByRole('button', { name: 'Dismiss highlight', exact: true }).click()
  console.log('PASS: denied capture recovery, synthetic preview, SDK image reply, and non-focusable highlight dismissal')

  await chat.getByRole('button', { name: 'Settings', exact: true }).click()
  await chat.getByLabel('Saved shake instruction', { exact: true }).fill('Explain the synthetic screen once.')
  await chat.getByLabel('Enable Shake to Help', { exact: true }).check()
  await chat.getByRole('button', { name: 'Save shake settings', exact: true }).click()
  await chat.getByText('Shake to Help is on.', { exact: true }).waitFor()
  await desktop.evaluate(({ screen }) => {
    const point = screen.getCursorScreenPoint()
    const trace = Array.from({ length: 33 }, (_, i) => [0, 40, 80, 40][i % 4])
    let n = 0
    screen.getCursorScreenPoint = () => ({ x: point.x + trace[Math.min(n++, trace.length - 1)], y: point.y })
  })
  await chat.locator('.user-message').getByText('[Shake to Help] Explain the synthetic screen once.', { exact: true }).waitFor()
  await chat.getByText('Synthetic screen fixture explanation.', { exact: true }).waitFor()
  const disabled = await chat.evaluate(() => window.triage.saveShakeSettings({ enabled: false, instruction: 'Explain the synthetic screen once.' }))
  assert.equal(disabled.ok, true)
  console.log('PASS: saved instruction and native monitor dispatch one synthetic shake through screen-to-SDK-to-history')

  await send('Fail the network fixture')
  await chat.getByText('failed: Anthropic is temporarily unavailable. Please try again later.', { exact: true }).waitFor()
  assert.equal(await chat.getByText('private-raw-fixture-error', { exact: false }).count(), 0)
  await send('Hold until Stop')
  await chat.getByRole('button', { name: '■ Stop', exact: true }).click()
  await chat.getByText('stopped: Stopped by you. No later reply will be added.', { exact: true }).waitFor()
  await send('Hold until suspend')
  await chat.getByRole('button', { name: '■ Stop', exact: true }).waitFor()
  await desktop.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend') })
  await chat.getByText('interrupted: Interrupted because this Mac went to sleep.', { exact: false }).waitFor()
  await desktop.evaluate(({ powerMonitor }) => { powerMonitor.emit('resume') })
  await send('Hold until display change')
  await chat.getByRole('button', { name: '■ Stop', exact: true }).waitFor()
  await desktop.evaluate(({ screen }) => { screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['bounds']) })
  await chat.getByText('interrupted: Interrupted because the display configuration changed.', { exact: false }).waitFor()
  await send('Hold until app shutdown')
  await chat.getByRole('button', { name: '■ Stop', exact: true }).waitFor()
  const pending = await chat.evaluate(async () => (await window.triage.getAssistantState()).value.active)
  await quit()
  const stopped = new HistoryStore(file)
  assert.equal(stopped.detail(pending.conversationId).messages.at(-1).status, 'stopped')
  stopped.close()
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    const payloads = database.prepare('SELECT payload_json FROM events').all()
    const serialized = JSON.stringify(payloads)
    assert.ok(!serialized.includes('fixture-only-not-a-real-provider-key'))
    assert.ok(!serialized.includes('private-raw-fixture-error'))
    assert.ok(!serialized.includes('data:image'))
    assert.ok(!serialized.includes('/9j/'))
    assert.ok(payloads.every((row) => row.payload_json.length < 5000))
  } finally { database.close() }
  console.log('PASS: actual SDK key setup, follow-up context, normalized network failure, Stop, and quit during a pending response')
  console.log('PASS: native sleep/display interruption handlers and metadata-only screen persistence')

  chat = await launch()
  assert.equal(await chat.evaluate(async () => (await window.triage.getAssistantState()).value.config.configured), false)
  await history(chat, 34)
  const card = chat.locator('.history-card').filter({ hasText: 'Interrupted browser fixture' })
  await card.getByRole('button', { name: /^Delete conversation:/ }).click()
  await card.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await card.count(), 1)
  await card.getByRole('button', { name: /^Delete conversation:/ }).click()
  await card.getByRole('button', { name: 'Delete permanently', exact: true }).click()
  await chat.waitForFunction(() => document.querySelectorAll('.history-card').length === 33)
  await chat.getByRole('button', { name: 'Clear all history', exact: true }).click()
  await chat.getByRole('button', { name: 'Confirm clear history', exact: true }).click()
  await chat.getByText('No conversations yet.', { exact: false }).waitFor()
  await quit()
  const restored = new HistoryStore(file)
  assert.equal(restored.list().items.length, 0)
  restored.close()
  assert.deepEqual(failures, [])
  console.log('PASS: full app restart, confirmed deletion, retained pagination, clear history, and clean shutdown')
} finally {
  await quit()
  rmSync(directory, { recursive: true, force: true })
}
