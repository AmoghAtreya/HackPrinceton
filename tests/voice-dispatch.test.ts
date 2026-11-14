import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { AppProblem } from '../src/main/assistant/errors.ts'
import type { DialogueTurn, ModelGateway } from '../src/main/assistant/model.ts'
import { VoiceSession } from '../src/main/voice/session.ts'
import { VoicePreferences, defaultVoiceSettings } from '../src/main/voice/settings.ts'
import { voiceControl } from '../src/main/voice/commands.ts'
import type { SpeechEvent } from '../src/main/voice/adapter.ts'

const KEY = 'fixture-only-voice-dispatch-not-a-real-provider-key'
const available = { microphone: 'authorized' as const, speech: 'authorized' as const,
  onDevice: true, available: true, devices: [{ id: 'fixture', label: 'Fixture' }] }
async function fixture(t: TestContext, options: { configured?: boolean; gateway?: Partial<ModelGateway>; teardown?: () => Promise<void> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-voice-dispatch-'))
  const file = join(directory, 'history.sqlite')
  const history = new HistoryStore(file)
  const credentials = new Credentials(directory, { available: async () => false,
    encrypt: async () => { throw Error() }, decrypt: async () => { throw Error() } })
  if (options.configured !== false) await credentials.connect(KEY, false, [{ id: 'fixture', label: 'Fixture' }])
  const contexts: DialogueTurn[][] = []
  const assistant = new AssistantCoordinator({ history, credentials, changed: () => {}, gateway: {
    models: async () => [], reply: async (_key, _model, turns) => { contexts.push(turns); return 'Fixture answer' }, ...options.gateway
  } })
  const adapters: Array<{ emit: (event: SpeechEvent) => void; lose: () => void; starts: number }> = []
  const voice = new VoiceSession(new VoicePreferences(directory), (emit, lose) => {
    const adapter = { emit, lose, starts: 0 }; adapters.push(adapter)
    return { initialize: async () => available, requestPermissions: async () => available,
      start: () => { adapter.starts++ }, finish: () => {}, cancel: () => {}, dispose: () => options.teardown?.() }
  }, () => {}, { start: 100, finish: 25, capture: 1000 }, {
    reserve: (id) => assistant.reserveVoice(id), release: (id) => assistant.releaseVoice(id),
    submit: (id, text, conversationId) => assistant.sendVoice(id, text, conversationId),
    stop: () => assistant.stopActive(), conversation: (id) => history.summary(id)
  })
  t.after(async () => { await voice.dispose(); assistant.dispose(); rmSync(directory, { recursive: true, force: true }) })
  voice.save({ ...defaultVoiceSettings, enabled: true }); await voice.setup()
  function emit(type: string, extra: object = {}, index = adapters.length - 1) {
    adapters[index].emit({ v: 1, seq: 1, generation: randomUUID(), sessionId: voice.snapshot().sessionId, type, ...extra } as SpeechEvent)
  }
  function listen() { const id = voice.start().sessionId!; emit('started'); return id }
  async function say(text: string) {
    if (!voice.snapshot().availability) await voice.setup()
    const id = listen(); voice.finish(id); emit('final', { text }); await tick()
    return voice.snapshot().receipt
  }
  return { assistant, voice, history, contexts, file, directory, adapters, emit, listen, say }
}

test('only finalized speech dispatches once, persists voice source, and follows the same context as text', async (t) => {
  const f = await fixture(t)
  f.voice.setChatOpen(true)
  const typed = f.assistant.send({ text: 'Typed introduction' }); await tick()
  f.voice.setContext({ view: 'chat', conversationId: typed.conversationId })
  const id = f.listen()
  f.emit('partial', { text: 'private partial never stored' })
  assert.equal(f.contexts.length, 1)
  f.voice.finish(id); f.voice.finish(id)
  f.emit('final', { text: 'First voice question' })
  f.emit('final', { sessionId: id, text: 'Duplicate must not run' })
  await tick()
  assert.equal(f.contexts.length, 2)
  const first = f.voice.snapshot().receipt!
  assert.equal(first.conversationId, typed.conversationId)
  assert.equal(f.voice.snapshot().conversationTitle, 'Typed introduction')
  await f.say('Voice follow-up')
  assert.deepEqual(f.contexts[2].map((turn) => turn.content), [
    'Typed introduction', 'Fixture answer', 'First voice question', 'Fixture answer', 'Voice follow-up'
  ])
  const detail = f.history.detail(first.conversationId)
  assert.deepEqual(detail.messages.filter((m) => m.role === 'user').map((m) => m.source), ['chat', 'voice', 'voice'])
  assert.ok(!JSON.stringify(detail).includes('private partial'))
  assert.ok(!readFileSync(join(f.directory, 'voice-settings.json'), 'utf8').includes('question'))
  assert.equal(f.voice.snapshot().draft, '')
})

test('voice reserves starting/listening/finalizing against typed and shake; rejection releases the slot', async (t) => {
  const f = await fixture(t)
  const id = f.voice.start().sessionId!
  const typed = () => f.assistant.send({ text: 'Typed draft remains in renderer until a receipt' })
  assert.throws(typed, /voice input/)
  f.emit('started'); assert.throws(typed, /voice input/)
  let captures = 0
  const skipped = f.assistant.shake({ point: { x: 1, y: 2 }, displayId: 'fixture', triggeredAt: Date.now() }, 'Explain', async () => { captures++; throw Error('must not capture') })
  assert.equal(captures, 0)
  assert.equal(f.history.detail(skipped!.conversationId).messages[0].status, 'failed')
  f.voice.finish(id); assert.throws(typed, /voice input/)
  f.emit('final', { text: '   ' })
  assert.doesNotThrow(typed); await tick()
})

test('capture during an active task is control-only even if that task finishes before finalization', async (t) => {
  let resolve!: (text: string) => void
  let calls = 0
  const f = await fixture(t, { gateway: { reply: async () => { calls++; return new Promise<string>((done) => { resolve = done }) } } })
  f.assistant.send({ text: 'Existing task' })
  const id = f.listen()
  resolve('Existing task finished'); await tick()
  f.voice.finish(id); f.emit('final', { text: 'Do not queue another task' })
  assert.equal(calls, 1)
  assert.match(f.voice.snapshot().notice, /still working/)
  assert.equal(f.voice.snapshot().draft, 'Do not queue another task')
  assert.equal(f.assistant.snapshot().active, null)
  assert.equal(f.history.list().items.length, 1)
})

test('spoken Stop is local, aborts existing work, and suppresses a late result', async (t) => {
  let resolve!: (text: string) => void
  let signal!: AbortSignal
  let calls = 0
  const f = await fixture(t, { gateway: { reply: async (_key, _model, _turns, current) => {
    calls++; signal = current; return new Promise<string>((done) => { resolve = done })
  } } })
  const running = f.assistant.send({ text: 'Hold this task' })
  await f.say(' Stop! ')
  assert.equal(signal.aborted, true)
  resolve('Late reply'); await tick()
  assert.equal(calls, 1)
  const detail = f.history.detail(running.conversationId)
  assert.equal(detail.messages.length, 1)
  assert.equal(detail.messages[0].status, 'stopped')
  assert.match(f.voice.snapshot().notice, /cannot be undone/)
  assert.equal(f.voice.snapshot().receipt, undefined)
})

test('local controls require no credentials and whole-command grammar never matches substrings', async (t) => {
  const f = await fixture(t, { configured: false })
  for (const text of ['Stop.', 'CANCEL!', 'stop speaking?', 'turn off voice']) assert.ok(voiceControl(text))
  for (const text of ['stop by the store', 'please cancel my flight', 'never stop', 'turn off voice later']) assert.equal(voiceControl(text), null)
  await f.say('cancel'); assert.match(f.voice.snapshot().notice, /Stop requested/)
  await f.say('stop speaking'); assert.match(f.voice.snapshot().notice, /task continues/)
  await f.say('turn off voice')
  assert.equal(f.voice.snapshot().settings.enabled, false)
  assert.equal(f.voice.snapshot().input, 'disabled')
  assert.equal(f.history.list().items.length, 0)
})

test('ordinary busy speech never queues; stop speaking and disabling voice preserve the task', async (t) => {
  const f = await fixture(t, { gateway: { reply: async () => new Promise(() => {}) } })
  const task = f.assistant.send({ text: 'Keep working' })
  await f.say('Another ordinary question')
  assert.match(f.voice.snapshot().notice, /still working/)
  await f.say('stop speaking')
  assert.equal(f.assistant.snapshot().active?.id, task.taskId)
  await f.say('turn off voice')
  assert.equal(f.assistant.snapshot().active?.id, task.taskId)
  assert.equal(f.history.list().items.length, 1)
})

test('history browsing does not adopt an old destination; explicit selection and New chat do', async (t) => {
  const f = await fixture(t)
  const old = f.assistant.send({ text: 'Historical chat' }); await tick()
  f.voice.setChatOpen(true)
  f.voice.setContext({ view: 'history', conversationId: old.conversationId })
  const fresh = (await f.say('New voice conversation'))!
  assert.notEqual(fresh.conversationId, old.conversationId)
  f.voice.setContext({ view: 'history', conversationId: old.conversationId })
  assert.equal((await f.say('Pinned follow-up'))!.conversationId, fresh.conversationId)
  f.voice.setContext({ view: 'chat', conversationId: old.conversationId, explicitSelection: true })
  assert.equal((await f.say('Explicit old conversation'))!.conversationId, old.conversationId)
  f.voice.setContext({ view: 'chat', conversationId: null, explicitSelection: true })
  const typed = f.assistant.send({ text: 'Typed new chat' }); await tick()
  f.voice.setContext({ view: 'chat', conversationId: typed.conversationId })
  assert.equal((await f.say('Voice joins the typed chat'))!.conversationId, typed.conversationId)
})

test('selection during capture or finalization cancels rather than retargeting; stale callbacks cannot send', async (t) => {
  for (const finalizing of [false, true]) {
    const f = await fixture(t)
    const old = f.assistant.send({ text: 'Existing conversation' }); await tick()
    const id = f.listen(); f.emit('partial', { text: 'discard on change' })
    if (finalizing) f.voice.finish(id)
    f.voice.setContext({ view: 'chat', conversationId: old.conversationId, explicitSelection: true })
    f.emit('final', { sessionId: id, text: 'Do not dispatch this' }, 0)
    assert.match(f.voice.snapshot().notice, /Conversation changed/)
    assert.equal(f.contexts.length, 1)
    assert.doesNotThrow(() => f.assistant.send({ text: 'Input slot released' })); await tick()
  }
})

test('screen/highlight and ambiguous visual speech are visible refusals with no task or capture', async (t) => {
  const f = await fixture(t)
  for (const text of ['Explain this screen', 'Show me where the export button is', 'What is that?', 'Look at my window', 'Highlight the control']) {
    await f.say(text)
    assert.match(f.voice.snapshot().notice, /No screenshot was taken/)
    assert.equal(f.voice.snapshot().draft, text)
  }
  assert.equal(f.contexts.length, 0)
  assert.equal(f.history.list().items.length, 0)
})

test('missing credentials and blocked storage create no model request and leave local controls usable', async (t) => {
  for (const configured of [false, true]) {
    const f = await fixture(t, { configured })
    if (configured) f.history.begin = () => { throw new AppProblem('storage', 'History unavailable') }
    await f.say('An ordinary question')
    assert.equal(f.contexts.length, 0)
    assert.equal(f.voice.snapshot().draft, 'An ordinary question')
    assert.match(f.voice.snapshot().notice, /Settings|History unavailable/)
    await f.say('stop')
    assert.match(f.voice.snapshot().notice, /Stop requested/)
  }
})

test('model failure and redaction use ordinary assistant outcomes with voice provenance', async (t) => {
  const f = await fixture(t, { gateway: { reply: async () => { throw new Error(KEY) } } })
  const receipt = (await f.say('Question containing ' + KEY))!
  const detail = f.history.detail(receipt.conversationId)
  assert.equal(detail.messages[0].source, 'voice')
  assert.equal(detail.messages[0].status, 'failed')
  assert.ok(!JSON.stringify(detail).includes(KEY))
  assert.equal(f.assistant.snapshot().active, null)
})

test('failed finalization holds reservation until audio teardown and cannot replay', async (t) => {
  let release!: () => void
  const closing = new Promise<void>((done) => { release = done })
  const f = await fixture(t, { teardown: () => closing })
  const id = f.listen(); f.emit('partial', { text: 'Recovery only' }); f.voice.finish(id)
  await delay(50)
  assert.equal(f.voice.snapshot().input, 'finalizing')
  assert.throws(() => f.assistant.send({ text: 'Wait for microphone closure' }), /voice input/)
  release(); await tick()
  assert.equal(f.voice.snapshot().input, 'error')
  assert.equal(f.voice.snapshot().draft, 'Recovery only')
  f.emit('final', { sessionId: id, text: 'Late callback' })
  assert.equal(f.contexts.length, 0)
  assert.doesNotThrow(() => f.assistant.send({ text: 'Fresh request' })); await tick()
})

test('all cancellation and failure paths release ownership without accepting unfinished speech', async (t) => {
  for (const action of ['cancel', 'hide', 'helper', 'suspend', 'disable', 'early-final', 'overlong', 'empty', 'quit']) {
    const f = await fixture(t)
    const id = f.listen()
    if (action === 'cancel') f.voice.cancel(id)
    if (action === 'hide') f.voice.setChatOpen(false)
    if (action === 'helper') f.adapters[0].lose()
    if (action === 'suspend') f.voice.suspend()
    if (action === 'disable') f.voice.save(defaultVoiceSettings)
    if (action === 'early-final') f.emit('final', { text: 'Premature' })
    if (action === 'overlong' || action === 'empty') {
      f.voice.finish(id); f.emit('final', { text: action === 'overlong' ? 'x'.repeat(4001) : '' })
    }
    if (action === 'quit') await f.voice.dispose()
    assert.equal(f.contexts.length, 0, action)
    assert.doesNotThrow(() => f.assistant.send({ text: 'Next typed request' }), action); await tick()
  }
})

test('voice provenance survives reopen, pagination, deletion and legacy chat reads without migration', async (t) => {
  const f = await fixture(t)
  const receipt = (await f.say('History fixture'))!
  for (let n = 0; n < 51; n++) {
    const next = f.history.begin('Voice fixture ' + n, 'fixture', receipt.conversationId, undefined, undefined, 'voice')
    f.history.complete(next.taskId, 'Answer')
  }
  const reopened = new HistoryStore(f.file)
  try {
    const page = reopened.detail(receipt.conversationId)
    assert.equal(page.messages.length, 100)
    const earlier = reopened.detail(receipt.conversationId, page.nextBefore!)
    assert.equal(earlier.messages.length, 4)
    assert.equal(earlier.messages[0].source, 'voice')
    reopened.delete(receipt.conversationId)
    assert.equal(reopened.list().items.length, 0)
  } finally { reopened.close() }
})

test('spoken clarification answers use the existing router and completed conversation context', async (t) => {
  const seen: DialogueTurn[][] = []
  const f = await fixture(t, { gateway: { route: async (_key, _model, turns) => {
    seen.push(turns)
    return { kind: 'reply', text: seen.length === 1 ? 'Which date?' : 'Clarification received.' }
  } } })
  const first = (await f.say('Help me plan a trip'))!
  const second = (await f.say('December twelfth'))!
  assert.equal(second.conversationId, first.conversationId)
  assert.deepEqual(seen[1].map((turn) => turn.content), ['Help me plan a trip', 'Which date?', 'December twelfth'])
  assert.equal(f.history.detail(first.conversationId).messages.at(-1)!.content, 'Clarification received.')
})

test('global hold keeps foreground-independent conversation ownership and dispatches once on release', async (t) => {
  const f = await fixture(t)
  const hold = randomUUID()
  f.voice.holdPressed(hold)
  const id = f.voice.snapshot().sessionId!
  f.emit('started'); f.emit('partial', { text: 'Provisional held text' })
  f.voice.setChatOpen(false)
  f.voice.holdPressed(hold) // autorepeat
  assert.equal(f.adapters[0].starts, 1)
  assert.equal(f.voice.snapshot().sessionId, id)
  assert.throws(() => f.assistant.send({ text: 'Competing typed text' }), /voice input/)
  assert.equal(f.contexts.length, 0)
  await delay(340)
  f.voice.holdReleased(hold)
  assert.equal(f.voice.snapshot().input, 'finalizing')
  f.voice.holdReleased(hold)
  f.emit('final', { text: 'Held question' }); f.emit('final', { sessionId: id, text: 'Duplicate' })
  await tick()
  assert.equal(f.contexts.length, 1)
  assert.equal(f.history.detail(f.voice.snapshot().conversationId!).messages[0].source, 'voice')
})

test('global tap, startup release, missed key-up and watchdog never dispatch or replay', async (t) => {
  for (const mode of ['tap', 'startup', 'missed-release', 'watchdog']) {
    const f = await fixture(t)
    const hold = randomUUID()
    f.voice.holdPressed(hold)
    const id = f.voice.snapshot().sessionId!
    if (mode !== 'startup') f.emit('started')
    if (mode === 'watchdog') f.emit('partial', { text: 'Watchdog recovery draft' })
    f.voice.holdReleased(hold, ['missed-release', 'watchdog'].includes(mode), mode)
    f.emit('started', { sessionId: id }); f.emit('final', { sessionId: id, text: 'Late result' })
    assert.equal(f.voice.snapshot().sessionId, null)
    assert.equal(f.contexts.length, 0)
    if (mode === 'watchdog') assert.equal(f.voice.snapshot().draft, 'Watchdog recovery draft')
    assert.doesNotThrow(() => f.assistant.send({ text: 'Input slot released' }))
  }
})

test('held local Stop cancels active work; ordinary busy holds are never queued', async (t) => {
  for (const text of ['Stop!', 'Another request']) {
    let complete!: (text: string) => void
    const f = await fixture(t, { gateway: { reply: async () => new Promise<string>((resolve) => { complete = resolve }) } })
    f.assistant.send({ text: 'Active task' })
    const hold = randomUUID(); f.voice.holdPressed(hold); f.emit('started')
    await delay(340); f.voice.holdReleased(hold); f.emit('final', { text })
    if (text === 'Stop!') assert.equal(f.assistant.snapshot().active, null)
    else assert.match(f.voice.snapshot().notice, /still working/)
    complete('Late answer'); await tick()
    assert.equal(f.history.list().items.length, 1)
  }
})
