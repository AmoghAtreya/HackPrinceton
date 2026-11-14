import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClaudeGateway } from '../src/main/assistant/model.ts'
import { parseGuideReply } from '../src/main/screen/coordinates.ts'
import type { ScreenImage } from '../src/shared/screen-contracts.ts'

const image: ScreenImage = {
  data: Buffer.from('synthetic-guide-image').toString('base64'), mediaType: 'image/jpeg',
  metadata: { id: 'guide-capture', capturedAt: Date.now(), displayId: 'one', displayName: 'Fixture',
    width: 1000, height: 500, bounds: { x: 0, y: 0, width: 2000, height: 1000 }, cursor: { x: 100, y: 100 } }
}
const offered = new Set(['e1', 'e2'])

test('a guide step names a listed element, or a pixel box, and says whether the goal is done', () => {
  assert.deepEqual(parseGuideReply('{"explanation":"Click the paperclip.","elementId":"e2","target":null,"done":false}', image.metadata, offered),
    { explanation: 'Click the paperclip.', captureId: 'guide-capture', target: null, elementId: 'e2', done: false })
  assert.deepEqual(parseGuideReply('{"explanation":"Click Send.","target":{"x1":100,"y1":100,"x2":300,"y2":150},"done":false}', image.metadata),
    { explanation: 'Click Send.', captureId: 'guide-capture', target: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 }, done: false })
})

test('a finished goal points at nothing, even if the model also named a control', () => {
  assert.deepEqual(parseGuideReply('{"explanation":"Your photo is attached.","elementId":"e1","target":null,"done":true}', image.metadata, offered),
    { explanation: 'Your photo is attached.', captureId: 'guide-capture', target: null, done: true })
})

test('guide replies fail closed: no done flag, an invented element, or extra prose', () => {
  const bad = [
    '{"explanation":"Click it.","elementId":"e1","target":null}',
    '{"explanation":"Click it.","elementId":"e9","target":null,"done":false}',
    '{"explanation":"Click it.","elementId":"e1","target":null,"done":"no"}',
    'Sure! {"explanation":"Click it.","elementId":"e1","target":null,"done":false}',
    '["not","an","object"]'
  ]
  for (const text of bad) assert.throws(() => parseGuideReply(text, image.metadata, offered), { code: 'invalid_target' }, text)
})

test('Claude is asked for only the next step, with the goal and earlier steps quoted', async () => {
  const gateway = new ClaudeGateway(async (input, init) => {
    const body = await new Request(input, init).json()
    assert.match(body.system, /ONE STEP AT A TIME/)
    assert.match(body.system, /"attach a photo"/)
    assert.match(body.system, /\["Click Compose\."\]/)
    assert.deepEqual(body.output_config.format.schema.required, ['explanation', 'elementId', 'target', 'done'])
    return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: '{"explanation":"Click the paperclip.","elementId":"e1","target":null,"done":false}' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
  })
  const reply = await gateway.locate('fake-test-key', 'claude-test', [{ role: 'user', content: 'help me attach a photo' }], new AbortController().signal, image,
    [{ id: 'e1', kind: 'button', label: 'Attach', region: 'main' }], undefined, { goal: 'attach a photo', done: ['Click Compose.'] })
  assert.equal(reply.elementId, 'e1')
  assert.equal(reply.done, false)
})
