import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceSession } from '../src/main/voice/session.ts'
import { VoicePreferences, defaultVoiceSettings } from '../src/main/voice/settings.ts'
import type { SpeechEvent } from '../src/main/voice/adapter.ts'
import type { VoiceAvailability } from '../src/shared/voice-contracts.ts'

const available: VoiceAvailability = { microphone: 'authorized', speech: 'authorized', available: true, onDevice: true, devices: [{ id: 'fixture-mic', label: 'Fixture microphone' }] }
function fixture(t: { after(fn: () => void): void }, options: { availability?: VoiceAvailability; deadlines?: { start: number; finish: number; capture: number }; deferred?: boolean; teardown?: () => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'triage-voice-session-'))
  const preferences = new VoicePreferences(dir)
  const adapters: Array<{ emit: (event: SpeechEvent) => void; lose: () => void; disposed: boolean; commands: string[]; release?: () => void }> = []
  let changes = 0
  const session = new VoiceSession(preferences, (emit, lose) => {
    const adapter = { emit, lose, disposed: false, commands: [] as string[], release: undefined as (() => void) | undefined }
    adapters.push(adapter)
    return {
      initialize: async () => options.availability ?? available,
      requestPermissions: async () => {
        if (options.deferred) await new Promise<void>((resolve) => { adapter.release = resolve })
        return options.availability ?? available
      },
      start: (id, device) => { adapter.commands.push(`start:${id}:${device}`) },
      finish: (id) => { adapter.commands.push(`finish:${id}`) },
      cancel: (id) => { adapter.commands.push(`cancel:${id}`) },
      dispose: () => { adapter.disposed = true; return options.teardown?.() }
    }
  }, () => { changes++ }, options.deadlines)
  t.after(() => { session.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const emit = (type: string, data: Record<string, unknown> = {}, index = adapters.length - 1) => adapters[index].emit({
    v: 1, generation: randomUUID(), seq: 1, type, sessionId: session.snapshot().sessionId, ...data
  } as SpeechEvent)
  return { session, preferences, adapters, emit, dir, changes: () => changes,
    enable: () => session.save({ ...defaultVoiceSettings, enabled: true }),
    listen: () => { const state = session.start(); emit('started'); return state.sessionId! } }
}

test('startup is dormant; ready initializes metadata and never opens input', async (t) => {
  const f = fixture(t)
  assert.equal(f.session.snapshot().input, 'disabled')
  assert.equal(f.adapters.length, 0)
  assert.throws(() => f.session.start())
  f.enable()
  assert.equal(f.adapters.length, 0)
  await f.session.setup()
  assert.equal(f.session.snapshot().input, 'ready')
  assert.deepEqual(f.adapters[0].commands, [])
  const restarted = new VoiceSession(new VoicePreferences(f.dir), () => { throw Error('must not initialize') }, () => {})
  assert.equal(restarted.snapshot().settings.enabled, true)
  assert.equal(restarted.snapshot().sessionId, null)
  assert.equal(restarted.snapshot().availability, null)
  restarted.dispose()
})
test('partials never finish a turn; Finish and final callback are accepted once without persistence', async (t) => {
  const f = fixture(t); f.enable(); await f.session.setup()
  const id = f.listen()
  assert.throws(() => f.session.start(), /Finish/)
  f.emit('partial', { text: 'synthetic utterance' })
  assert.equal(f.session.snapshot().draft, '')
  assert.equal(f.session.snapshot().input, 'listening')
  f.emit('level', { level: 0.4 })
  assert.equal(f.session.snapshot().level, 0.4)
  f.session.finish(id); f.session.finish(id)
  assert.equal(f.adapters[0].commands.filter((command) => command.startsWith('finish:')).length, 1)
  f.emit('final', { text: ' synthetic final ' })
  assert.equal(f.session.snapshot().input, 'ready')
  assert.equal(f.session.snapshot().draft, 'synthetic final')
  f.emit('final', { sessionId: id, text: 'duplicate' })
  assert.equal(f.session.snapshot().draft, 'synthetic final')
  assert.equal(f.session.snapshot().level, 0)
  assert.deepEqual(readdirSync(f.dir), ['voice-settings.json'])
  assert.ok(!readFileSync(join(f.dir, 'voice-settings.json'), 'utf8').includes('synthetic'))
})
test('cancel during startup disposes generation and ignores late started/final events', async (t) => {
  const f = fixture(t); f.enable(); await f.session.setup()
  const id = f.session.start().sessionId!
  f.session.finish(id)
  assert.equal(f.adapters[0].disposed, true)
  const changes = f.changes()
  f.emit('started', { sessionId: id })
  f.emit('final', { sessionId: id, text: 'late' })
  assert.equal(f.changes(), changes)
  assert.equal(f.session.snapshot().sessionId, null)
  await f.session.setup(); const next = f.listen()
  f.emit('failed', { sessionId: id, reason: 'audio' }, 0)
  assert.equal(f.session.snapshot().sessionId, next)
})
test('finish timeout releases helper, preserves draft, and cannot replay late results', async (t) => {
  const f = fixture(t, { deadlines: { start: 1000, capture: 1000, finish: 15 } })
  f.enable(); await f.session.setup(); const id = f.listen()
  f.emit('partial', { text: 'recover this synthetic draft' })
  f.session.finish(id)
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(f.session.snapshot().input, 'error')
  assert.equal(f.session.snapshot().draft, 'recover this synthetic draft')
  assert.equal(f.adapters[0].disposed, true)
  f.emit('final', { sessionId: id, text: 'late' })
  assert.equal(f.session.snapshot().draft, 'recover this synthetic draft')
})
test('startup timeout and maximum capture duration close resources', async (t) => {
  const f = fixture(t, { deadlines: { start: 15, capture: 15, finish: 1000 } })
  f.enable(); await f.session.setup(); f.session.start()
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(f.adapters[0].disposed, true)
  assert.equal(f.session.snapshot().sessionId, null)
  await f.session.setup(); f.listen(); f.emit('partial', { text: 'watchdog draft' })
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(f.adapters[1].disposed, true)
  assert.equal(f.session.snapshot().draft, 'watchdog draft')
})
test('empty, overlong, and early-final speech never becomes an accepted transcript', async (t) => {
  const f = fixture(t); f.enable(); await f.session.setup()
  let id = f.listen(); f.session.finish(id); f.emit('final', { text: '   ' })
  assert.equal(f.session.snapshot().draft, '')
  assert.match(f.session.snapshot().notice, /catch/)
  id = f.listen(); f.session.finish(id); f.emit('final', { text: 'x'.repeat(4001) })
  assert.equal(f.session.snapshot().input, 'error')
  assert.equal(f.session.snapshot().draft.length, 4001)
  f.listen(); f.emit('partial', { text: 'early' }); f.emit('final', { text: 'early' })
  assert.equal(f.session.snapshot().input, 'error')
  assert.equal(f.adapters[0].disposed, true)
})
test('permission denial, missing assets and absent selected device fail closed', async (t) => {
  for (const availability of [
    { ...available, microphone: 'denied' as const }, { ...available, speech: 'denied' as const },
    { ...available, onDevice: false }, { ...available, available: false }, { ...available, devices: [] }
  ]) {
    const f = fixture(t, { availability }); f.enable(); await f.session.setup()
    assert.equal(f.session.snapshot().input, 'error')
    assert.throws(() => f.session.start())
    assert.deepEqual(f.adapters[0].commands, [])
  }
  const f = fixture(t)
  f.session.save({ ...defaultVoiceSettings, enabled: true, microphoneId: 'disconnected' })
  await f.session.setup()
  assert.match(f.session.snapshot().notice, /microphone/)
  assert.throws(() => f.session.start())
})
test('device/permission loss and helper loss invalidate current session', async (t) => {
  for (const failure of ['device', 'permission', 'helper']) {
    const f = fixture(t); f.enable(); await f.session.setup(); f.listen()
    f.emit('partial', { text: 'failure recovery' })
    if (failure === 'helper') f.adapters[0].lose()
    else f.emit('failed', { reason: failure })
    assert.equal(f.session.snapshot().input, 'error')
    assert.equal(f.session.snapshot().sessionId, null)
    assert.equal(f.session.snapshot().draft, 'failure recovery')
    assert.equal(f.adapters[0].disposed, true)
  }
})
test('disable, reconfiguration, lock/sleep and quit release input with no automatic resume', async (t) => {
  for (const action of ['disable', 'reconfigure', 'suspend', 'dispose']) {
    const f = fixture(t); f.enable(); await f.session.setup(); const id = f.listen()
    f.emit('partial', { text: 'private provisional' })
    if (action === 'disable') f.session.save(defaultVoiceSettings)
    if (action === 'reconfigure') f.session.save({ ...defaultVoiceSettings, enabled: true, shortcut: 'Control+A' })
    if (action === 'suspend') { f.session.suspend(); await assert.rejects(() => f.session.setup()); f.session.resume() }
    if (action === 'dispose') f.session.dispose()
    assert.equal(f.adapters[0].disposed, true)
    assert.equal(f.session.snapshot().sessionId, null)
    assert.equal(f.session.snapshot().level, 0)
    f.emit('started', { sessionId: id })
    assert.equal(f.session.snapshot().sessionId, null)
    assert.throws(() => f.session.start())
  }
})
test('late permission approval after disable cannot re-enable or start audio', async (t) => {
  const f = fixture(t, { deferred: true }); f.enable()
  const setup = f.session.setup()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.session.snapshot().input, 'starting', 'Pending permission/setup must not advertise ready')
  f.session.save(defaultVoiceSettings)
  f.adapters[0].release!(); await setup
  assert.equal(f.session.snapshot().input, 'disabled')
  assert.equal(f.session.snapshot().availability, null)
  assert.equal(f.adapters[0].disposed, true)
})

test('ready/disabled wait for asynchronous microphone closure and block reactivation', async (t) => {
  for (const action of ['cancel', 'disable', 'suspend', 'quit']) {
    let release!: () => void
    const teardown = new Promise<void>((resolve) => { release = resolve })
    const f = fixture(t, { teardown: () => teardown })
    f.enable(); await f.session.setup(); const id = f.listen()
    let shutdown: Promise<void> | undefined
    if (action === 'cancel') f.session.cancel(id)
    if (action === 'disable') f.session.save(defaultVoiceSettings)
    if (action === 'suspend') f.session.suspend()
    if (action === 'quit') shutdown = f.session.dispose()
    assert.equal(f.session.snapshot().input, 'finalizing')
    assert.equal(f.session.snapshot().sessionId, null)
    assert.throws(() => f.session.start())
    await assert.rejects(() => f.session.setup())
    f.emit('started', { sessionId: id })
    assert.equal(f.session.snapshot().input, 'finalizing')
    release(); await shutdown; await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.session.snapshot().input, action === 'cancel' ? 'ready' : action === 'suspend' ? 'suspended' : 'disabled')
  }
})
