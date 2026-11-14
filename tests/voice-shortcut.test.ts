import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { VoiceSession } from '../src/main/voice/session.ts'
import { VoiceShortcut } from '../src/main/voice/shortcut.ts'
import { VoicePreferences, defaultVoiceSettings } from '../src/main/voice/settings.ts'
import type { SpeechEvent } from '../src/main/voice/adapter.ts'
import type { VoiceShortcutState } from '../src/shared/voice-contracts.ts'
const available = { microphone: 'authorized' as const, speech: 'authorized' as const,
  onDevice: true, available: true, devices: [{ id: 'fixture', label: 'Fixture' }] }

test('shortcut replacement conflicts preserve durable preference and the actual old binding', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-shortcut-'))
  const prefs = new VoicePreferences(dir)
  const voice = new VoiceSession(prefs, () => ({ initialize: async () => available,
    requestPermissions: async () => available, start() {}, finish() {}, cancel() {}, dispose() {} }), () => {})
  let chord: string | null = null
  let event!: (event: SpeechEvent) => void
  let lost!: () => void
  let disposed = 0
  let status: VoiceShortcutState['status'] = 'registered'
  const shortcuts = new VoiceShortcut(voice, (receive, failure) => {
    event = receive; lost = failure
    return { initialize: async () => available, requestPermissions: async () => available,
      start() { throw Error('keyboard helper must never open audio') }, finish() {}, cancel() {},
      dispose() { disposed++ }, registerShortcut: async (next) => {
        if (status === 'registered') chord = next
        return { chord, status, notice: status }
      } }
  })
  t.after(() => { shortcuts.dispose(); void voice.dispose(); rmSync(dir, { recursive: true, force: true }) })
  await shortcuts.save({ ...defaultVoiceSettings, enabled: true })
  await shortcuts.setup()
  assert.equal(voice.snapshot().shortcut?.chord, 'Control+Option+Space')
  status = 'conflict'
  await assert.rejects(() => shortcuts.save({ ...prefs.snapshot(), shortcut: 'Control+A' }), /conflict/)
  assert.equal(prefs.snapshot().shortcut, 'Control+Option+Space')
  assert.equal(voice.snapshot().shortcut?.chord, 'Control+Option+Space')
  const holdId = randomUUID()
  event({ type: 'pressed', holdId } as SpeechEvent)
  assert.equal(voice.snapshot().activation, 'hold')
  lost()
  assert.equal(voice.snapshot().sessionId, null)
  assert.equal(voice.snapshot().shortcut?.status, 'unavailable')
  assert.equal(disposed, 1)
  event({ type: 'pressed', holdId: randomUUID() } as SpeechEvent)
  assert.equal(voice.snapshot().sessionId, null)
})

test('denied global permission preserves manual input and suspension prevents held replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-shortcut-denied-'))
  let starts = 0
  let prompts = 0
  const voice = new VoiceSession(new VoicePreferences(dir), () => ({ initialize: async () => available,
    requestPermissions: async () => available, start() { starts++ }, finish() {}, cancel() {}, dispose() {} }), () => {})
  const shortcuts = new VoiceShortcut(voice, () => ({ initialize: async () => available,
    requestPermissions: async () => available, start() { throw Error() }, finish() {}, cancel() {}, dispose() {},
    registerShortcut: async (_chord, prompt) => { if (prompt) prompts++; return { chord: null, status: 'denied', notice: 'Allow Input Monitoring' } }
  }))
  t.after(() => { shortcuts.dispose(); void voice.dispose(); rmSync(dir, { recursive: true, force: true }) })
  await shortcuts.save({ ...defaultVoiceSettings, enabled: true })
  assert.equal(prompts, 0)
  await shortcuts.setup()
  assert.equal(prompts, 1)
  assert.equal(voice.snapshot().shortcut?.status, 'denied')
  const id = voice.start().sessionId!
  assert.equal(starts, 1)
  voice.cancel(id)
  shortcuts.suspend(); voice.suspend()
  shortcuts.resume(); voice.resume()
  assert.equal(voice.snapshot().sessionId, null)
  assert.equal(starts, 1)
})

test('disabling voice during deferred shortcut setup cannot re-enable it on a late acknowledgement', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-shortcut-disable-'))
  const voice = new VoiceSession(new VoicePreferences(dir), () => { throw Error('audio must stay dormant') }, () => {})
  let acknowledge!: (value: VoiceShortcutState) => void
  const shortcuts = new VoiceShortcut(voice, () => ({ initialize: async () => available,
    requestPermissions: async () => available, start() {}, finish() {}, cancel() {}, dispose() {},
    registerShortcut: () => new Promise((resolve) => { acknowledge = resolve }) }))
  t.after(async () => { await shortcuts.dispose(); await voice.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const saving = shortcuts.save({ ...defaultVoiceSettings, enabled: true })
  await new Promise((resolve) => setImmediate(resolve))
  await shortcuts.save(defaultVoiceSettings)
  acknowledge({ chord: 'Control+Option+Space', status: 'registered', notice: 'Late acknowledgement' })
  await assert.rejects(() => saving, /interrupted/)
  assert.equal(voice.snapshot().settings.enabled, false)
  assert.equal(voice.snapshot().input, 'disabled')
  assert.equal(voice.snapshot().sessionId, null)
})

test('live state observation retains first-enable binding and rearms audio after cancelled capture', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-shortcut-observer-'))
  let shortcuts: VoiceShortcut | undefined
  let keyboardDisposed = 0
  let audioInitialized = 0
  let audioPermissions = 0
  const voice = new VoiceSession(new VoicePreferences(dir), () => ({
    initialize: async () => { audioInitialized++; return available },
    requestPermissions: async () => { audioPermissions++; return available },
    start() {}, finish() {}, cancel() {}, dispose() {}
  }), (state) => shortcuts?.observe(state))
  shortcuts = new VoiceShortcut(voice, () => ({ initialize: async () => available,
    requestPermissions: async () => available, start() { throw Error('no keyboard-owned audio') }, finish() {}, cancel() {},
    dispose() { keyboardDisposed++ }, registerShortcut: async (chord) => ({ status: 'registered', chord, notice: 'Registered' }) }))
  t.after(async () => { await shortcuts!.dispose(); await voice.dispose(); rmSync(dir, { recursive: true, force: true }) })
  await shortcuts.save({ ...defaultVoiceSettings, enabled: true })
  assert.equal(voice.snapshot().shortcut?.status, 'registered')
  assert.equal(keyboardDisposed, 0)
  await shortcuts.setup()
  const id = voice.start().sessionId!
  voice.cancel(id)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(keyboardDisposed, 0)
  assert.equal(audioInitialized, 2)
  assert.equal(audioPermissions, 1, 'Warm recovery does not prompt again')
  assert.equal(voice.snapshot().availability?.available, true)
  assert.equal(voice.snapshot().input, 'ready')
  await shortcuts.save(defaultVoiceSettings)
  assert.equal(keyboardDisposed, 1)
  assert.equal(voice.snapshot().shortcut?.chord, null)
})
