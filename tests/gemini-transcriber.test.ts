import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GeminiTranscriber, pcmToWav, transcriptionHints } from '../src/main/voice/gemini-transcriber.ts'

const key = 'AIza' + 'x'.repeat(35)
const signal = new AbortController().signal
const audio = [new Uint8Array([1, 0, 2, 0]), new Uint8Array([3, 0])]

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => { calls.push({ url: String(url), init }); return respond() }) as typeof fetch
  return { fetcher, calls }
}
const answer = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }))

test('PCM becomes a valid 16 kHz mono WAV', () => {
  const wav = pcmToWav(audio, 16000)
  assert.equal(wav.length, 44 + 6)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(40), 6)
  assert.deepEqual([...wav.subarray(44)], [1, 0, 2, 0, 3, 0])
})

test('the recording is sent as audio/wav with word hints, and the key stays out of the URL', async () => {
  const { fetcher, calls } = fakeFetch(() => answer('{"text":"Open Gmail.","clarity":"clear"}'))
  const result = await new GeminiTranscriber({ fetcher }).transcribe(key, audio, 16000, signal)
  assert.deepEqual(result, { text: 'Open Gmail.', clarity: 'clear' })
  assert.doesNotMatch(calls[0].url, /AIza/)
  assert.match(calls[0].url, /gemini-flash-latest:generateContent$/)
  const body = JSON.parse(String(calls[0].init.body))
  assert.equal(body.contents[0].parts[0].inline_data.mime_type, 'audio/wav')
  assert.match(body.contents[0].parts[1].text, /Gmail/)
  assert.match(transcriptionHints(), /Medicare/)
})

test('any failure returns null so the on-device transcript is kept', async () => {
  const cases: Array<() => Response | Promise<Response>> = [
    () => new Response('{"error":{}}', { status: 429 }),
    () => new Response('{"error":{}}', { status: 400 }),
    () => answer('not json'),
    () => answer('{"words":"wrong shape"}'),
    () => { throw new TypeError('fetch failed') }
  ]
  for (const respond of cases) {
    const { fetcher } = fakeFetch(respond)
    assert.equal(await new GeminiTranscriber({ fetcher }).transcribe(key, audio, 16000, signal), null)
  }
  assert.equal(await new GeminiTranscriber({ fetcher: fakeFetch(() => answer('{}')).fetcher }).transcribe(key, [], 16000, signal), null)
})

test('a slow Gemini reply times out and falls back', async () => {
  const fetcher = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })) as unknown as typeof fetch
  // AbortSignal.timeout does not keep Node alive on its own; the app always has other work running.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const started = Date.now()
    assert.equal(await new GeminiTranscriber({ fetcher, timeoutMs: 50 }).transcribe(key, audio, 16000, signal), null)
    assert.ok(Date.now() - started < 2000)
  } finally { clearInterval(keepAlive) }
})

test('a busy main model (503) is retried once on the lighter model', async () => {
  const { fetcher, calls } = fakeFetch(() => calls.length === 1 ? new Response('{}', { status: 503 }) : answer('{"text":"Is this safe?","clarity":"clear"}'))
  const result = await new GeminiTranscriber({ fetcher }).transcribe(key, audio, 16000, signal)
  assert.deepEqual(result, { text: 'Is this safe?', clarity: 'clear' })
  assert.deepEqual(calls.map((call) => call.url.split('/models/')[1]), ['gemini-flash-latest:generateContent', 'gemini-flash-lite-latest:generateContent'])
})

test('a rejected key is not retried', async () => {
  const { fetcher, calls } = fakeFetch(() => new Response('{}', { status: 401 }))
  assert.equal(await new GeminiTranscriber({ fetcher }).transcribe(key, audio, 16000, signal), null)
  assert.equal(calls.length, 1)
})

test('a slow main model hands over to the lighter model within the overall limit', async () => {
  let call = 0
  const fetcher = ((_url: string, init: RequestInit) => {
    call++
    if (call === 1) return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    return Promise.resolve(answer('{"text":"Open Gmail.","clarity":"clear"}'))
  }) as unknown as typeof fetch
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const started = Date.now()
    const result = await new GeminiTranscriber({ fetcher, firstAttemptMs: 60, timeoutMs: 2000 }).transcribe(key, audio, 16000, signal)
    assert.deepEqual(result, { text: 'Open Gmail.', clarity: 'clear' })
    assert.equal(call, 2)
    assert.ok(Date.now() - started < 1500)
  } finally { clearInterval(keepAlive) }
})

test('cancelling stops without trying the lighter model', async () => {
  const controller = new AbortController()
  let calls = 0
  const fetcher = ((_url: string, init: RequestInit) => {
    calls++
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  }) as unknown as typeof fetch
  setTimeout(() => controller.abort(), 20)
  assert.equal(await new GeminiTranscriber({ fetcher }).transcribe(key, audio, 16000, controller.signal), null)
  assert.equal(calls, 1)
})

test('thinking is switched off, and a model that refuses that setting is asked again without it', async () => {
  const bodies: Array<{ generationConfig: { thinkingConfig?: unknown } }> = []
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    if (body.generationConfig.thinkingConfig) return new Response('{"error":{"message":"Thinking budget is not supported for this model."}}', { status: 400 })
    return answer('{"text":"Open Gmail.","clarity":"clear"}')
  }) as unknown as typeof fetch
  const transcriber = new GeminiTranscriber({ fetcher, fallbackModel: null })
  assert.deepEqual(await transcriber.transcribe(key, audio, 16000, signal), { text: 'Open Gmail.', clarity: 'clear' })
  assert.deepEqual(bodies.map((body) => Boolean(body.generationConfig.thinkingConfig)), [true, false])
  await transcriber.transcribe(key, audio, 16000, signal)
  assert.equal(bodies.length, 3, 'remembered: the next request skips the refused setting')
  assert.equal(bodies[2].generationConfig.thinkingConfig, undefined)
})

test('a vague "invalid argument" is asked again without the thinking setting', async () => {
  const bodies: Array<{ generationConfig: { thinkingConfig?: unknown } }> = []
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    if (body.generationConfig.thinkingConfig) return new Response('{"error":{"message":"Request contains an invalid argument."}}', { status: 400 })
    return answer('{"text":"Circle the button.","clarity":"clear"}')
  }) as unknown as typeof fetch
  assert.deepEqual(await new GeminiTranscriber({ fetcher, fallbackModel: null }).transcribe(key, audio, 16000, signal), { text: 'Circle the button.', clarity: 'clear' })
  assert.deepEqual(bodies.map((body) => Boolean(body.generationConfig.thinkingConfig)), [true, false])
})
