import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VoiceController, type FinalTranscriber, type VoiceEvent } from '../src/main/voice/controller.ts'
import { LocalTranscriptStore } from '../src/main/voice/transcript-store.ts'
import { AudioQueue } from '../src/main/voice/audio-queue.ts'
import { parseResult, type TranscribeResult } from '../src/main/voice/transcribe.ts'

/** Stand-in for Amazon Transcribe: a partial per chunk, one final when the audio ends. */
function fakeService(options: { fail?: Error } = {}) {
  return {
    config: { region: 'test', languageCode: 'en-US' as const },
    name: 'fake',
    id: 'apple' as const,
    verify: async () => {},
    dispose() {},
    async stream(audio: AsyncIterable<Uint8Array>, _rate: number, signal: AbortSignal, onResult: (result: TranscribeResult) => void) {
      let bytes = 0
      for await (const chunk of audio) {
        if (signal.aborted) return
        if (options.fail) throw options.fail
        bytes += chunk.byteLength
        onResult({ segmentId: 's1', text: 'track my', isFinal: false, confidence: null, startTime: 0, endTime: 0 })
      }
      onResult({ segmentId: 's1', text: `track my package ${bytes}`, isFinal: true, confidence: 0.9, startTime: 0, endTime: 1 })
    }
  }
}

function setup(service = fakeService(), finalTranscriber?: FinalTranscriber) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-voice-'))
  const store = new LocalTranscriptStore(directory)
  // The fake implements SpeechToTextService.
  const voice = new VoiceController({ service: service as never, store, ensureMicrophone: async () => {}, finalTranscriber })
  const events: VoiceEvent[] = []
  voice.subscribe((event) => events.push(event))
  return { directory, store, voice, events, cleanup: () => { voice.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}

test('a recording streams valid audio, stores the final transcript and publishes events in order', async () => {
  const { store, voice, events, cleanup } = setup()
  try {
    const { sessionId } = await voice.start()
    await assert.rejects(voice.start(), { code: 'busy' })
    voice.pushAudio(sessionId, new Uint8Array(3200))
    voice.pushAudio(sessionId, new Uint8Array(3201)) // odd length: not 16-bit PCM
    voice.pushAudio('another-session', new Uint8Array(3200))
    voice.pushAudio(sessionId, new Uint8Array(3200))
    const record = await voice.finish(sessionId)
    assert.equal(record.status, 'completed')
    assert.equal(record.text, 'track my package 6400')
    assert.equal(await voice.finish(sessionId), record, 'finishing twice returns the same record')
    assert.deepEqual((await store.recent(5)).map((saved) => saved.text), ['track my package 6400'])
    const kinds = events.map((event) => event.type === 'speech_state' ? event.state : event.type === 'user_utterance' ? (event.isFinal ? 'final' : 'partial') : event.type)
    assert.deepEqual(kinds, ['listening', 'thinking', 'partial', 'partial', 'final', 'transcript', 'idle'])
  } finally { cleanup() }
})

test('a cancelled recording is never stored', async () => {
  const { store, voice, cleanup } = setup()
  try {
    const { sessionId } = await voice.start()
    voice.pushAudio(sessionId, new Uint8Array(3200))
    await voice.cancel(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(await store.recent(5), [])
    assert.equal(voice.snapshot().state, 'idle')
    await assert.rejects(voice.finish(sessionId), { code: 'voice_ended' })
  } finally { cleanup() }
})

test('a Transcribe failure with nothing heard ends the session with that error', async () => {
  const { AppProblem } = await import('../src/main/assistant/errors.ts')
  const { voice, events, cleanup } = setup(fakeService({ fail: new AppProblem('aws_access', 'Not allowed.') }))
  try {
    const { sessionId } = await voice.start()
    voice.pushAudio(sessionId, new Uint8Array(3200))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const last = events.at(-1)
    assert.equal(last?.type, 'speech_state')
    assert.equal(last?.type === 'speech_state' && last.error, 'Not allowed.')
    assert.equal(voice.snapshot().state, 'idle')
  } finally { cleanup() }
})

test('the transcript store keeps the newest records first and skips corrupted lines', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-transcripts-'))
  try {
    const store = new LocalTranscriptStore(directory)
    const record = (id: string) => ({ id, startedAt: 1, endedAt: 2, languageCode: 'en-US', status: 'completed' as const, text: id, segments: [] })
    await store.save(record('a'))
    await store.save(record('b'))
    const { appendFileSync } = await import('node:fs')
    appendFileSync(store.file, '{not json\n')
    assert.deepEqual((await store.recent(5)).map((saved) => saved.id), ['b', 'a'])
    assert.match(readFileSync(store.file, 'utf8'), /"id":"a"/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('the audio queue hands chunks to a waiting reader and stops after end', async () => {
  const queue = new AudioQueue(10)
  const iterator = queue[Symbol.asyncIterator]()
  const pending = iterator.next()
  assert.equal(queue.push(new Uint8Array(4)), true)
  assert.equal((await pending).value?.byteLength, 4)
  assert.equal(queue.push(new Uint8Array(8)), true)
  assert.equal(queue.push(new Uint8Array(8)), false, 'over the buffer limit is dropped')
  queue.end()
  assert.equal(queue.push(new Uint8Array(1)), false)
  assert.equal((await iterator.next()).value?.byteLength, 8)
  assert.equal((await iterator.next()).done, true)
})

test('Transcribe results become segments with mean word confidence on finals only', () => {
  const final = parseResult({ ResultId: 'r1', IsPartial: false, StartTime: 0.5, EndTime: 1.5, Alternatives: [{ Transcript: ' Open Gmail ',
    Items: [{ Type: 'pronunciation', Confidence: 0.8 }, { Type: 'pronunciation', Confidence: 1 }, { Type: 'punctuation', Confidence: 0 }] }] })
  assert.deepEqual(final, { segmentId: 'r1', text: 'Open Gmail', isFinal: true, confidence: 0.9, startTime: 0.5, endTime: 1.5 })
  assert.equal(parseResult({ ResultId: 'r2', IsPartial: true, Alternatives: [{ Transcript: 'Open' }] })?.confidence, null)
  assert.equal(parseResult({ IsPartial: false, Alternatives: [{ Transcript: 'x' }] }), null)
})

test('Gemini writes the final transcript while the live engine only captions', async () => {
  let received = 0
  const { store, voice, cleanup } = setup(fakeService(), async (recording, rate) => {
    received = recording.reduce((total, chunk) => total + chunk.byteLength, 0)
    assert.equal(rate, 16000)
    return { text: 'Track my package, please.', clarity: 'clear' }
  })
  try {
    const { sessionId } = await voice.start()
    voice.pushAudio(sessionId, new Uint8Array(3200)); voice.pushAudio(sessionId, new Uint8Array(3200))
    const record = await voice.finish(sessionId)
    assert.equal(received, 6400)
    assert.equal(record.text, 'Track my package, please.')
    assert.equal(record.transcribedBy, 'gemini')
    assert.equal(record.captionText, 'track my package 6400')
    assert.equal(record.segments[0].confidence, 0.95)
    assert.equal((await store.recent(1))[0].transcribedBy, 'gemini')
  } finally { cleanup() }
})

test('no Gemini answer keeps the on-device transcript', async () => {
  for (const answer of [null, { text: '', clarity: 'clear' as const }]) {
    const { voice, cleanup } = setup(fakeService(), async () => answer)
    try {
      const { sessionId } = await voice.start()
      voice.pushAudio(sessionId, new Uint8Array(3200))
      const record = await voice.finish(sessionId)
      assert.equal(record.text, 'track my package 3200')
      assert.equal(record.transcribedBy, 'apple')
      assert.equal(record.captionText, undefined)
    } finally { cleanup() }
  }
  const { voice, cleanup } = setup(fakeService(), async () => { throw new Error('offline') })
  try {
    const { sessionId } = await voice.start()
    voice.pushAudio(sessionId, new Uint8Array(3200))
    assert.equal((await voice.finish(sessionId)).transcribedBy, 'apple')
  } finally { cleanup() }
})

test('an unclear Gemini transcript is marked low confidence so it is checked before sending', async () => {
  const { voice, cleanup } = setup(fakeService(), async () => ({ text: 'Open G mail', clarity: 'unclear' }))
  try {
    const { sessionId } = await voice.start()
    voice.pushAudio(sessionId, new Uint8Array(3200))
    assert.equal((await voice.finish(sessionId)).segments[0].confidence, 0.5)
  } finally { cleanup() }
})

test('cancelling a recording aborts Gemini and stores nothing', async () => {
  let aborted = false
  const { store, voice, cleanup } = setup(fakeService(), (_recording, _rate, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { aborted = true; resolve(null) })
  }))
  try {
    const { sessionId } = await voice.start()
    voice.pushAudio(sessionId, new Uint8Array(3200))
    const finishing = voice.finish(sessionId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await voice.cancel(sessionId)
    await finishing
    assert.equal(aborted, true)
    assert.deepEqual(await store.recent(5), [])
  } finally { cleanup() }
})

test('Gemini rescues a recording when the live engine fails', async () => {
  const { AppProblem } = await import('../src/main/assistant/errors.ts')
  const { voice, events, cleanup } = setup(fakeService({ fail: new AppProblem('speech_failed', 'Helper stopped.') }),
    async () => ({ text: 'Is this safe?', clarity: 'clear' }))
  try {
    const { sessionId } = await voice.start()
    voice.pushAudio(sessionId, new Uint8Array(3200))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const transcript = events.find((event) => event.type === 'transcript')
    assert.equal(transcript?.type === 'transcript' && transcript.record.text, 'Is this safe?')
    assert.equal(transcript?.type === 'transcript' && transcript.record.status, 'completed')
  } finally { cleanup() }
})

test('an empty final after live captions keeps the last caption instead of losing it', async () => {
  const service = {
    ...fakeService(), id: 'apple' as const,
    async stream(audio: AsyncIterable<Uint8Array>, _rate: number, _signal: AbortSignal, onResult: (result: TranscribeResult) => void) {
      for await (const _chunk of audio) onResult({ segmentId: 's1', text: 'testing testing one two three', isFinal: false, confidence: null, startTime: 0, endTime: 1 })
      onResult({ segmentId: 's1', text: '', isFinal: true, confidence: null, startTime: 0, endTime: 1 })
    }
  }
  const { voice, cleanup } = setup(service, async () => null)
  try {
    const { sessionId } = await voice.start()
    voice.pushAudio(sessionId, new Uint8Array(3200))
    const record = await voice.finish(sessionId)
    assert.equal(record.text, 'testing testing one two three')
    assert.equal(record.transcribedBy, 'apple')
    assert.equal(record.segments[0].confidence, null)
  } finally { cleanup() }
})

test('truly silent recordings still come back empty', async () => {
  const service = {
    ...fakeService(), id: 'apple' as const,
    async stream(audio: AsyncIterable<Uint8Array>, _rate: number, _signal: AbortSignal, onResult: (result: TranscribeResult) => void) {
      for await (const _chunk of audio) { /* no speech */ }
      onResult({ segmentId: 's1', text: '', isFinal: true, confidence: null, startTime: 0, endTime: 0 })
    }
  }
  const { voice, cleanup } = setup(service, async () => null)
  try {
    const { sessionId } = await voice.start()
    voice.pushAudio(sessionId, new Uint8Array(3200))
    assert.equal((await voice.finish(sessionId)).text, '')
  } finally { cleanup() }
})
