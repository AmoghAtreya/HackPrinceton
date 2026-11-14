import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connect } from 'node:net'
import { AppleSpeechService, looksLikeRestart, type HelperLauncher } from '../src/main/voice/apple-speech.ts'
import { AudioQueue } from '../src/main/voice/audio-queue.ts'
import type { SpeechToTextResult } from '../src/main/voice/speech-to-text.ts'

/** A stand-in for the Swift helper: speaks the same socket protocol. */
function fakeHelper(script: (send: (message: object) => void, frames: { kind: string; bytes: number }[], end: () => void) => void,
  onFrame?: (kind: string, send: (message: object) => void) => void): { launch: HelperLauncher; frames: { kind: string; bytes: number }[] } {
  const frames: { kind: string; bytes: number }[] = []
  const launch: HelperLauncher = async (_app, [socketPath]) => {
    const socket = connect(socketPath)
    const send = (message: object) => socket.write(JSON.stringify(message) + '\n')
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1)
        if (pending.length < 5 + length) break
        const kind = String.fromCharCode(pending[0])
        frames.push({ kind, bytes: length })
        pending = pending.subarray(5 + length)
        onFrame?.(kind, send)
      }
    })
    socket.on('connect', () => script(send, frames, () => socket.end()))
  }
  return { launch, frames }
}

async function run(service: AppleSpeechService, chunks: number, signal = new AbortController().signal) {
  const queue = new AudioQueue()
  const results: SpeechToTextResult[] = []
  const done = service.stream(queue, 16000, signal, (result) => results.push(result))
  for (let index = 0; index < chunks; index++) queue.push(new Uint8Array(3200))
  queue.end()
  await done
  return results
}

test('audio is sent after ready, then partial and final results come back', async () => {
  const helper = fakeHelper((send) => send({ type: 'ready' }), (kind, send) => {
    if (kind === 'A') send({ type: 'result', text: 'open', isFinal: false, confidence: null })
    if (kind === 'E') { send({ type: 'result', text: 'open gmail', isFinal: true, confidence: 0.9 }); send({ type: 'done' }) }
  })
  const service = new AppleSpeechService('/fake/TriageSpeechHelper.app', { launch: helper.launch })
  const results = await run(service, 3)
  assert.deepEqual(helper.frames.map((frame) => `${frame.kind}:${frame.bytes}`), ['A:3200', 'A:3200', 'A:3200', 'E:0'])
  assert.deepEqual(results.map((result) => [result.segmentId, result.text, result.isFinal, result.confidence]),
    [['apple-0', 'open', false, null], ['apple-0', 'open', false, null], ['apple-0', 'open', false, null], ['apple-0', 'open gmail', true, 0.9]])
})

test('a denied permission becomes a plain-language problem', async () => {
  const helper = fakeHelper((send, _frames, end) => { send({ type: 'error', code: 'speech_denied', message: 'no' }); end() })
  const service = new AppleSpeechService('/fake/TriageSpeechHelper.app', { launch: helper.launch })
  await assert.rejects(run(service, 1), { code: 'speech_permission' })
})

test('a helper that cannot be opened is reported with the build command', async () => {
  const service = new AppleSpeechService('/fake/TriageSpeechHelper.app', { launch: async () => { throw new Error('LSOpen failed') } })
  await assert.rejects(run(service, 1), (error: Error) => /npm run speech:build/.test(error.message))
})

test('verify fails clearly when the helper has not been built', async () => {
  if (process.platform !== 'darwin') return
  await assert.rejects(new AppleSpeechService('/nonexistent/TriageSpeechHelper.app').verify(), { code: 'speech_helper_missing' })
})

test('a transcript that starts over after a pause is a restart; corrections are not', () => {
  assert.equal(looksLikeRestart('Can you take me to my Amazon orders', 'And'), true)
  assert.equal(looksLikeRestart('Can you take me to my Amazon orders', 'And then show'), true)
  assert.equal(looksLikeRestart('Ken you', 'Can you take'), false, 'a longer revision is a correction')
  assert.equal(looksLikeRestart('Can you take me', 'Can you'), false, 'same start: still the same sentence')
  assert.equal(looksLikeRestart('Hello', 'Help'), false, 'one word is too little to judge')
})

test('words said before a pause are kept when Apple starts its transcript over', async () => {
  const captions = ['Can you take', 'Can you take me to my orders', 'And', 'And then show me']
  const helper = fakeHelper((send) => send({ type: 'ready' }), (kind, send) => {
    if (kind === 'A') { const next = captions.shift(); if (next) send({ type: 'result', text: next, isFinal: false, confidence: null }) }
    if (kind === 'E') { send({ type: 'result', text: 'And then show me where', isFinal: true, confidence: 0.9 }); send({ type: 'done' }) }
  })
  const results = await run(new AppleSpeechService('/fake/TriageSpeechHelper.app', { launch: helper.launch }), 4)
  const finals = results.filter((result) => result.isFinal).map((result) => [result.segmentId, result.text])
  assert.deepEqual(finals, [['apple-0', 'Can you take me to my orders'], ['apple-1', 'And then show me where']])
})
