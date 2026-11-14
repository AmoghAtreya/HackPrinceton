import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClaudeGateway } from '../src/main/assistant/model.ts'
const key = 'fixture-only-not-a-real-provider-key'
const messages = [{ role: 'user' as const, content: 'Search Alaska flights' }, { role: 'assistant' as const, content: 'Which airport?' }, { role: 'user' as const, content: 'SEA' }]
function gateway(text: string, stop_reason = 'end_turn') {
  return new ClaudeGateway(async (input, init) => {
    const request = new Request(input, init); const body = await request.json()
    assert.equal(new URL(request.url).origin, 'https://api.anthropic.com')
    assert.deepEqual(body.messages, messages); assert.equal(body.tools, undefined)
    assert.match(body.system, /Never execute an old request/)
    return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text }], stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
  })
}
test('SDK flight routing preserves clarification context and validates extracted fields', async () => {
  const flight = { originAirport: 'SEA', destinationAirport: null, tripType: null, departureDate: null, returnDate: null, adults: null, unsupportedPassengers: false }
  assert.deepEqual(await gateway(JSON.stringify({ kind: 'flight_search', flight })).route(key, 'fixture', messages, new AbortController().signal), { kind: 'flight_search', flight })
})
test('malformed unsupported and truncated model routes never become browser actions', async () => {
  for (const text of ['not JSON', '{"kind":"purchase","text":"buy"}', '{"kind":"flight_search","flight":{}}']) {
    await assert.rejects(gateway(text).route(key, 'fixture', messages, new AbortController().signal), /invalid request/)
  }
  await assert.rejects(gateway('{"kind":"reply","text":"partial"}', 'max_tokens').route(key, 'fixture', messages, new AbortController().signal), /incomplete/)
})
