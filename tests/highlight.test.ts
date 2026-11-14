import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureSize, mapRectangle, parseHighlightReply, rectangleSchema } from '../src/main/screen/coordinates.ts'
import { HighlightController, type DisplayGeometry } from '../src/main/screen/highlight.ts'
import type { CaptureMetadata } from '../src/shared/screen-contracts.ts'

const capture = (): CaptureMetadata => ({
  id: 'capture-test', capturedAt: Date.now(), displayId: 'two', displayName: 'Fixture',
  width: 1000, height: 500, bounds: { x: -2000, y: 120, width: 2000, height: 1000 },
  cursor: { x: 500, y: 250 }, scaleFactor: 2, rotation: 0
})
const target = { x: 0.1, y: 0.2, width: 0.2, height: 0.1 }

test('pixel boxes normalize using the exact unpadded image and bind the local capture ID', () => {
  const result = parseHighlightReply(JSON.stringify({ explanation: 'This is the save control.', target: { x1: 100, y1: 100, x2: 300, y2: 150 } }), capture())
  assert.deepEqual(result, { explanation: 'This is the save control.', captureId: 'capture-test', target })
  assert.deepEqual(parseHighlightReply('{"explanation":"Which control do you mean?","target":null}', capture()).target, null)
})
test('a single JSON code fence preserves exact validated target coordinates', () => {
  const json = '{"explanation":"Explore is in the sidebar.","target":{"x1":100,"y1":100,"x2":300,"y2":150}}'
  const fenced = '\x60\x60\x60json\n' + json + '\n\x60\x60\x60'
  assert.deepEqual(parseHighlightReply(fenced, capture()), parseHighlightReply(json, capture()))
  assert.throws(() => parseHighlightReply('Here is the result:\n' + fenced, capture()), /invalid JSON format/)
  assert.throws(() => parseHighlightReply('\x60\x60\x60json\n{"explanation":"bad","target":{"x1":0,"y1":0,"x2":1001,"y2":20}}\n\x60\x60\x60', capture()), /coordinates outside/)
})
test('response errors distinguish format shape and coordinate failures without raw content', () => {
  assert.throws(() => parseHighlightReply('private unparseable response', capture()), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /invalid JSON format/)
    assert.ok(!error.message.includes('private unparseable'))
    return true
  })
  assert.throws(() => parseHighlightReply('{"message":"wrong fields"}', capture()), /unexpected response fields/)
})

test('malformed out-of-bounds empty inverted and non-finite targets are rejected', () => {
  for (const box of [
    { x1: -1, y1: 0, x2: 20, y2: 20 }, { x1: 0, y1: 0, x2: 1001, y2: 20 },
    { x1: 20, y1: 0, x2: 10, y2: 20 }, { x1: 10, y1: 10, x2: 10, y2: 10 },
    { x1: 0, y1: 0, x2: Infinity, y2: 20 }, { x1: 0, y1: 0, x2: 20, y2: 501 }
  ]) assert.throws(() => parseHighlightReply(JSON.stringify({ explanation: 'Fixture', target: box }), capture()), /No reliable/)
  for (const text of ['not json', '{"explanation":"","target":null}', '{"explanation":"test","target":null,"captureId":"model-invented"}']) {
    assert.throws(() => parseHighlightReply(text, capture()), /No reliable/)
  }
  assert.equal(rectangleSchema.safeParse({ ...target, x: NaN }).success, false)
  assert.equal(rectangleSchema.safeParse({ ...target, x: 0.9 }).success, false)
})
test('mapping handles negative origins Retina scaling and resized images without double scaling', () => {
  const mapped = mapRectangle(target, capture().bounds)
  assert.deepEqual(mapped, {
    local: { x: 200, y: 200, width: 400, height: 100 },
    desktop: { x: -1800, y: 320, width: 400, height: 100 }
  })
  const second = parseHighlightReply('{"explanation":"Fixture","target":{"x1":50,"y1":50,"x2":150,"y2":75}}', { ...capture(), width: 500, height: 250 })
  assert.deepEqual(mapRectangle(second.target!, capture().bounds), mapped)
  assert.throws(() => mapRectangle({ ...target, width: 0.00001 }, capture().bounds), /too small/)
})
test('capture dimensions preserve shape and stay inside the conservative vision patch budget', () => {
  for (const [width, height] of [[3000, 2000], [1200, 1200], [3840, 2160], [500, 4000], [800, 600], [1280, 960]]) {
    const result = captureSize(width, height)
    assert.ok(Math.max(result.width, result.height) <= 1280)
    assert.ok(result.width * result.height <= 1000000)
    assert.ok(Math.ceil(result.width / 28) * Math.ceil(result.height / 28) <= 1568)
    assert.ok(Math.abs(result.width / result.height - width / height) < 0.01)
  }
  assert.throws(() => captureSize(NaN, 1), /Invalid/)
  assert.throws(() => captureSize(0, 1), /Invalid/)
})

function fixture() {
  const metadata = capture()
  let display: DisplayGeometry | undefined = { bounds: { ...metadata.bounds }, scaleFactor: 2, rotation: 0 }
  let draws = 0
  let hides = 0
  let clicked: (() => void) | undefined
  const controller = new HighlightController({
    display: () => display, draw: () => { draws++ }, hide: () => { hides++ },
    observeClick: (_target, callback) => { clicked = callback; return () => { clicked = undefined } }
  })
  const reply = { explanation: 'Fixture', captureId: metadata.id, target }
  return { metadata, controller, reply, replace: (value: DisplayGeometry | undefined) => { display = value },
    counts: () => ({ draws, hides }), click: () => clicked?.(), observing: () => Boolean(clicked) }
}
test('highlights persist until target click and notify state observers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const f = fixture()
  let changes = 0
  const off = f.controller.onChange(() => changes++)
  try {
    const plan = f.controller.plan(f.reply, f.metadata, 'task', f.controller.revision)!
    assert.equal(f.controller.present(plan), true)
    assert.ok(f.controller.snapshot())
    assert.equal(f.controller.snapshot()!.expiresAt, null)
    t.mock.timers.tick(60000)
    assert.ok(f.controller.snapshot())
    assert.equal(changes, 1)
    assert.equal(f.observing(), true)
    f.click()
    assert.equal(f.controller.snapshot(), null)
    assert.equal(f.observing(), false)
    assert.equal(changes, 2)
    assert.equal(f.counts().draws, 1)
  } finally { off(); f.controller.dispose() }
})
test('manual dismissal stops target click observation', () => {
  const f = fixture()
  try {
    const plan = f.controller.plan(f.reply, f.metadata, 'task', f.controller.revision)!
    assert.equal(f.controller.present(plan), true)
    assert.equal(f.observing(), true)
    f.controller.clear()
    assert.equal(f.observing(), false)
    f.click()
    assert.equal(f.controller.snapshot(), null)
  } finally { f.controller.dispose() }
})
test('dismissal and capture replacement invalidate prepared highlights and late display', () => {
  const f = fixture()
  try {
    const revision = f.controller.revision
    const plan = f.controller.plan(f.reply, f.metadata, 'task', revision)!
    f.controller.clear()
    assert.equal(f.controller.present(plan), false)
    assert.throws(() => f.controller.plan(f.reply, f.metadata, 'task', revision), /expired/)
    assert.equal(f.counts().draws, 0)
  } finally { f.controller.dispose() }
})
test('capture identity age scale rotation and display bounds must still match', () => {
  for (const change of ['identity', 'age', 'scale', 'rotation', 'bounds', 'removed']) {
    const f = fixture()
    try {
      if (change === 'identity') f.reply.captureId = 'another-capture'
      if (change === 'age') f.metadata.capturedAt -= 31000
      if (change === 'scale') f.replace({ bounds: f.metadata.bounds, scaleFactor: 1, rotation: 0 })
      if (change === 'rotation') f.replace({ bounds: f.metadata.bounds, scaleFactor: 2, rotation: 90 })
      if (change === 'bounds') f.replace({ bounds: { ...f.metadata.bounds, x: 0 }, scaleFactor: 2, rotation: 0 })
      if (change === 'removed') f.replace(undefined)
      assert.throws(() => f.controller.plan(f.reply, f.metadata, 'task', f.controller.revision), /expired/)
      assert.equal(f.counts().draws, 0)
    } finally { f.controller.dispose() }
  }
})
test('covered controls are rejected before presentation and duplicate frames do not extend display', () => {
  const metadata = capture()
  let blocked = true
  let draws = 0
  const controller = new HighlightController({
    display: () => ({ bounds: metadata.bounds, scaleFactor: 2, rotation: 0 }),
    blocked: () => blocked, draw: () => { draws++ }, hide: () => {}
  })
  try {
    const reply = { explanation: 'Fixture', captureId: metadata.id, target }
    assert.throws(() => controller.plan(reply, metadata, 'task', controller.revision), /covering/)
    blocked = false
    const plan = controller.plan(reply, metadata, 'task', controller.revision)!
    assert.equal(controller.present(plan), true)
    assert.equal(controller.present(plan), false)
    assert.equal(draws, 1)
  } finally { controller.dispose() }
})

test('null targets draw nothing and shutdown prevents prepared targets from reappearing', () => {
  const f = fixture()
  assert.equal(f.controller.plan({ ...f.reply, target: null }, f.metadata, 'task', f.controller.revision), null)
  const plan = f.controller.plan(f.reply, f.metadata, 'task', f.controller.revision)!
  f.controller.dispose()
  assert.equal(f.controller.present(plan), false)
  assert.equal(f.counts().draws, 0)
})
