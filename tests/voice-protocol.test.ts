import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { HelperFrames, helperEventSchema, MAX_FRAME } from '../src/main/voice/adapter.ts'
import { installVoiceIpc } from '../src/main/voice/ipc.ts'
import { voiceChannels } from '../src/shared/voice-contracts.ts'
import type { VoiceSession } from '../src/main/voice/session.ts'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

test('helper framing survives fragmented UTF-8 and bounds chunks, frames and queue', () => {
  const frames = new HelperFrames()
  const bytes = Buffer.from(JSON.stringify({ text: 'synthetic café' }) + '\n')
  const split = bytes.indexOf(Buffer.from('é')) + 1
  assert.deepEqual(frames.push(bytes.subarray(0, split)), [])
  assert.deepEqual(frames.push(bytes.subarray(split)), [{ text: 'synthetic café' }])
  assert.throws(() => new HelperFrames().push(Buffer.alloc(MAX_FRAME + 1, 32)))
  assert.throws(() => new HelperFrames().push(Buffer.from('{}\n'.repeat(33))))
  assert.throws(() => new HelperFrames().push(Buffer.from('not-json\n')))
  const fragmented = new HelperFrames()
  fragmented.push(Buffer.alloc(MAX_FRAME, 32))
  assert.throws(() => fragmented.push(Buffer.from('x')))
})
test('helper discriminated protocol rejects invalid IDs, levels, unknown fields and oversized text', () => {
  const base = { v: 1, seq: 1, generation: randomUUID(), sessionId: randomUUID() }
  assert.equal(helperEventSchema.parse({ ...base, type: 'final', text: 'fixture' }).type, 'final')
  for (const message of [
    { ...base, type: 'final', text: 'x'.repeat(12001) }, { ...base, type: 'level', level: 2 },
    { ...base, type: 'level', level: NaN }, { ...base, type: 'started', path: '/tmp/worker' },
    { ...base, type: 'partial', text: 'x', seq: 0 }, { ...base, type: 'started', generation: 'stale' },
    { ...base, type: 'execute', text: 'something' }, { ...base, type: 'started', v: 2 }
  ]) assert.equal(helperEventSchema.safeParse(message).success, false)
})
test('every voice IPC checks trust before validation and forbids extra/privileged arguments', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  let calls = 0
  const session = Object.fromEntries(['snapshot', 'save', 'setup', 'start', 'finish', 'cancel', 'setContext'].map((name) => [name, () => { calls++; return 'fixture' }])) as unknown as VoiceSession
  const ipc = {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler) },
    removeHandler: (name: string) => { handlers.delete(name) }
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>
  const remove = installVoiceIpc(ipc, session, (event) => event === 'trusted' as unknown as IpcMainInvokeEvent)
  for (const [name, handler] of handlers) {
    const result = await handler('untrusted', { arbitrary: true }) as { ok: boolean; error: { code: string } }
    assert.equal(result.ok, false); assert.equal(result.error.code, 'untrusted', name)
  }
  assert.equal(calls, 0)
  for (const name of [voiceChannels.get, voiceChannels.setup, voiceChannels.start]) {
    assert.equal((await handlers.get(name)!('trusted', { helper: '/tmp/a' }) as { ok: boolean }).ok, false)
    assert.equal((await handlers.get(name)!('trusted', undefined, 'extra') as { ok: boolean }).ok, false)
  }
  assert.equal((await handlers.get(voiceChannels.finish)!('trusted', 'old') as { ok: boolean }).ok, false)
  assert.equal((await handlers.get(voiceChannels.cancel)!('trusted', { sessionId: randomUUID() }) as { ok: boolean }).ok, false)
  assert.equal((await handlers.get(voiceChannels.save)!('trusted', { enabled: true, source: 'voice' }) as { ok: boolean }).ok, false)
  for (const patch of [
    { source: 'voice' }, { helper: '/tmp/arbitrary' }, { conversationId: 'invalid' },
    { view: 'other' }, { explicitSelection: 'yes' }
  ]) assert.equal((await handlers.get(voiceChannels.context)!('trusted', {
    view: 'chat', conversationId: null, ...patch
  }) as { ok: boolean }).ok, false)
  assert.equal(calls, 0)
  assert.equal((await handlers.get(voiceChannels.context)!('trusted', { view: 'chat', conversationId: null }) as { ok: boolean }).ok, true)
  assert.equal(calls, 1)
  assert.equal((await handlers.get(voiceChannels.start)!('trusted') as { ok: boolean }).ok, true)
  assert.equal(calls, 2)
  remove(); assert.equal(handlers.size, 0)
})

test('nonactivating status surface can read cancel and stop but cannot start or retarget input', async () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<{ ok: boolean; error?: { code: string } }>>()
  const calls: string[] = []
  const session = Object.fromEntries(['snapshot', 'save', 'setup', 'start', 'finish', 'cancel', 'stop', 'setContext']
    .map((name) => [name, () => { calls.push(name); return 'fixture' }])) as unknown as VoiceSession
  const ipc = { handle: (name: string, handler: never) => handlers.set(name, handler), removeHandler() {} } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>
  installVoiceIpc(ipc, session, () => false, session, (event) => event === 'status' as unknown as IpcMainInvokeEvent)
  for (const name of [voiceChannels.start, voiceChannels.setup, voiceChannels.save, voiceChannels.context, voiceChannels.finish]) {
    const result = await handlers.get(name)!('status')
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'untrusted')
  }
  assert.deepEqual(calls, [])
  assert.equal((await handlers.get(voiceChannels.get)!('status')).ok, true)
  assert.equal((await handlers.get(voiceChannels.cancel)!('status', randomUUID())).ok, true)
  assert.equal((await handlers.get(voiceChannels.stop)!('status')).ok, true)
  assert.deepEqual(calls, ['snapshot', 'cancel', 'stop'])
})
