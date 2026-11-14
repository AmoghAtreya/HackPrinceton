import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GeminiGateway, ProviderGateway, isGeminiKey } from '../src/main/assistant/gemini.ts'
import { redact } from '../src/main/assistant/redaction.ts'
import type { ModelGateway } from '../src/main/assistant/model.ts'

const key = 'AIza' + 'x'.repeat(35)
const signal = new AbortController().signal

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const { status = 200, body } = handler(String(url), init)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetcher, calls }
}

const textReply = (text: string, finishReason = 'STOP') => ({ candidates: [{ content: { parts: [{ text }] }, finishReason }] })

test('Gemini keys are recognised and redacted', () => {
  assert.equal(isGeminiKey(key), true)
  assert.equal(isGeminiKey('sk-ant-api03-abcdefghijklmnop'), false)
  assert.equal(redact(`my key is ${key} ok`), 'my key is [redacted API key] ok')
})

test('models lists Gemini text models and sends the key only in a header', async () => {
  const { fetcher, calls } = fakeFetch(() => ({ body: { models: [
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] }
  ] } }))
  const models = await new GeminiGateway(fetcher).models(key, signal)
  assert.deepEqual(models, [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }])
  assert.doesNotMatch(calls[0].url, /AIza/)
  assert.equal((calls[0].init.headers as Record<string, string>)['x-goog-api-key'], key)
})

test('route parses JSON into the shared route schema and maps roles', async () => {
  const { fetcher, calls } = fakeFetch(() => ({ body: textReply('{"kind":"open_page","destination":"amazon_orders"}') }))
  const route = await new GeminiGateway(fetcher).route(key, 'gemini-2.5-flash', [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'take me to my orders' }
  ], signal)
  assert.deepEqual(route, { kind: 'open_page', destination: 'amazon_orders' })
  const body = JSON.parse(String(calls[0].init.body))
  assert.deepEqual(body.contents.map((turn: { role: string }) => turn.role), ['user', 'model', 'user'])
  assert.equal(body.generationConfig.responseMimeType, 'application/json')
  assert.match(body.systemInstruction.parts[0].text, /open_page/)
})

test('an invented URL or unknown route is rejected', async () => {
  const { fetcher } = fakeFetch(() => ({ body: textReply('{"kind":"open_page","destination":"https://evil.example"}') }))
  await assert.rejects(new GeminiGateway(fetcher).route(key, 'gemini-2.5-flash', [{ role: 'user', content: 'x' }], signal), { code: 'invalid_route' })
})

test('provider errors become readable problems', async () => {
  const invalid = fakeFetch(() => ({ status: 400, body: '{"error":{"message":"API key not valid. Please pass a valid API key."}}' }))
  await assert.rejects(new GeminiGateway(invalid.fetcher).reply(key, 'gemini-2.5-flash', [{ role: 'user', content: 'x' }], signal), { code: 'authentication' })
  const limited = fakeFetch(() => ({ status: 429, body: '{}' }))
  await assert.rejects(new GeminiGateway(limited.fetcher).reply(key, 'gemini-2.5-flash', [{ role: 'user', content: 'x' }], signal), { code: 'rate_limit' })
  const blocked = fakeFetch(() => ({ body: { promptFeedback: { blockReason: 'SAFETY' } } }))
  await assert.rejects(new GeminiGateway(blocked.fetcher).reply(key, 'gemini-2.5-flash', [{ role: 'user', content: 'x' }], signal), { code: 'request_rejected' })
})

test('the provider gateway sends Gemini keys to Gemini and others to Claude', async () => {
  const fake = (name: string): ModelGateway => ({ models: async () => [{ id: name, label: name }], reply: async () => name })
  const gateway = new ProviderGateway(fake('claude'), fake('gemini'))
  assert.equal(await gateway.reply(key, 'm', [], signal), 'gemini')
  assert.equal(await gateway.reply('sk-ant-api03-abcdefghijklmnop', 'm', [], signal), 'claude')
})
