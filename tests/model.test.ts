import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClaudeGateway } from '../src/main/assistant/model.ts'

const KEY = 'unit-test-only-key-not-a-real-provider-credential'
const turns = [{ role: 'user' as const, content: 'Hello, Triage.' }]

test('the real SDK lists models through the fixed Anthropic endpoint', async () => {
  const gateway = new ClaudeGateway(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.origin, 'https://api.anthropic.com')
    assert.equal(url.pathname, '/v1/models')
    assert.equal(request.headers.get('authorization'), 'Bearer ' + KEY)
    return Response.json({
      data: [{ id: 'claude-test', display_name: 'Test Claude', type: 'model', created_at: '2026-01-01T00:00:00Z' }],
      has_more: false, first_id: 'claude-test', last_id: 'claude-test'
    })
  })
  assert.deepEqual(await gateway.models(KEY, new AbortController().signal), [{ id: 'claude-test', label: 'Test Claude' }])
})

test('the SDK sends bounded text-only requests and returns only user-visible text', async () => {
  const gateway = new ClaudeGateway(async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).pathname, '/v1/messages')
    const body = await request.json()
    assert.equal(body.model, 'claude-test')
    assert.equal(body.max_tokens, 2048)
    assert.deepEqual(body.messages, turns)
    assert.equal(body.tools, undefined)
    assert.match(body.system, /cannot see/)
    return Response.json({
      id: 'msg_unit_test', type: 'message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'Hello back.' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3 }
    })
  })
  assert.equal(await gateway.reply(KEY, 'claude-test', turns, new AbortController().signal), 'Hello back.')
})

test('authentication errors are normalized and raw provider details are not exposed', async () => {
  let calls = 0
  const gateway = new ClaudeGateway(async () => {
    calls++
    return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Do not leak ' + KEY } }, { status: 401 })
  })
  await assert.rejects(gateway.reply(KEY, 'claude-test', turns, new AbortController().signal), (error: Error & { code: string }) => {
    assert.equal(error.code, 'authentication')
    assert.ok(!error.message.includes(KEY))
    return true
  })
  assert.equal(calls, 1)
})

test('SDK transport cancellation is propagated without retries', async () => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const gateway = new ClaudeGateway(async (input, init) => {
    const request = new Request(input, init)
    started()
    return new Promise<Response>((_resolve, reject) => {
      if (request.signal.aborted) reject(new DOMException('Aborted', 'AbortError'))
      else request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  })
  const controller = new AbortController()
  const pending = gateway.reply(KEY, 'claude-test', turns, controller.signal)
  await ready
  controller.abort()
  await assert.rejects(pending, (error: Error & { code: string }) => error.code === 'stopped')
})

test('empty text responses fail instead of recording a fabricated answer', async () => {
  const gateway = new ClaudeGateway(async () => Response.json({
    id: 'msg_empty', type: 'message', role: 'assistant', model: 'claude-test',
    content: [], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 }
  }))
  await assert.rejects(gateway.reply(KEY, 'claude-test', turns, new AbortController().signal), /No usable text/)
})
