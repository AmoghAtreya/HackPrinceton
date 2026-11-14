import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClaudeGateway } from '../src/main/assistant/model.ts'
import type { ScreenImage } from '../src/shared/screen-contracts.ts'

const image: ScreenImage = {
  data: Buffer.from('synthetic-highlight-image').toString('base64'), mediaType: 'image/jpeg',
  metadata: { id: 'local-capture-id', capturedAt: Date.now(), displayId: 'one', displayName: 'Fixture',
    width: 1000, height: 500, bounds: { x: 0, y: 0, width: 2000, height: 1000 }, cursor: { x: 100, y: 100 } }
}
const messages = [{ role: 'user' as const, content: 'Where is save?' }]
function response(text: string, reason = 'end_turn') {
  return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-test',
    content: [{ type: 'text', text }], stop_reason: reason, usage: { input_tokens: 1, output_tokens: 1 } })
}
test('the real SDK requests pixel boxes with a no-resize image and returns locally normalized guidance', async () => {
  const gateway = new ClaudeGateway(async (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, 'https://api.anthropic.com')
    const body = await request.json()
    assert.match(body.system, /1000 by 500/)
    assert.match(body.system, /IMAGE PIXELS/)
    assert.match(body.system, /untrusted/)
    assert.equal(body.tools, undefined)
    const format = body.output_config.format
    assert.equal(format.type, 'json_schema')
    assert.equal(format.schema.additionalProperties, false)
    assert.deepEqual(format.schema.required, ['explanation', 'target'])
    assert.equal(format.parse, undefined)
    const schemas = [format.schema, ...(Object.values(format.schema.$defs ?? {}))] as Array<Record<string, any>>
    const targetSchema = format.schema.properties.target.anyOf.find((item: any) => item.type === 'object') ?? schemas.find((item) => item.properties?.x1)
    assert.ok(targetSchema)
    assert.equal(targetSchema.additionalProperties, false)
    assert.deepEqual(targetSchema.required, ['x1', 'y1', 'x2', 'y2'])
    assert.deepEqual(body.messages[0].content[0].transformations, { oversized_image: 'error' })
    assert.equal(body.messages[0].content[0].source.data, image.data)
    return response('{"explanation":"Save is here.","target":{"x1":100,"y1":100,"x2":300,"y2":150}}')
  })
  assert.deepEqual(await gateway.locate('fake-test-key', 'claude-test', messages, new AbortController().signal, image), {
    explanation: 'Save is here.', captureId: 'local-capture-id', target: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 }
  })
})
test('malformed and truncated location responses fail without repairing or drawing guessed coordinates', async () => {
  for (const [text, reason] of [['not json', 'end_turn'], ['{"explanation":"partial","target":null}', 'max_tokens']]) {
    let calls = 0
    const gateway = new ClaudeGateway(async () => { calls++; return response(text, reason) })
    await assert.rejects(gateway.locate('fake-test-key', 'claude-test', messages, new AbortController().signal, image), /No reliable|incomplete/)
    assert.equal(calls, 1)
  }
})
test('an ambiguous target returns explanation only', async () => {
  const gateway = new ClaudeGateway(async () => response('{"explanation":"Please open the form first.","target":null}'))
  const result = await gateway.locate('fake-test-key', 'claude-test', messages, new AbortController().signal, image)
  assert.equal(result.target, null)
  assert.match(result.explanation, /open the form/)
})
