import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as settle } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { ClaudeGateway } from '../src/main/assistant/model.ts'
import { locateElements, readFrame } from '../src/main/context/locate.ts'
import { PairedCapture } from '../src/main/context/paired-capture.ts'
import { ContextService } from '../src/main/context/service.ts'
import { mapFrame, parseHighlightReply } from '../src/main/screen/coordinates.ts'
import { HighlightController, HIGHLIGHT_LOST_MESSAGE, highlightSource, type DisplayGeometry } from '../src/main/screen/highlight.ts'
import { ScreenService } from '../src/main/screen/service.ts'
import type { ElementAnchor, FrameReading, HighlightReply, HighlightState, LocateElement, Rectangle } from '../src/shared/highlight-contracts.ts'
import type { CaptureMetadata, ScreenImage } from '../src/shared/screen-contracts.ts'

const fixtureText = readFileSync(new URL('./fixtures/context-login.json', import.meta.url), 'utf8')
const DATA = Buffer.from('not-a-real-screenshot').toString('base64')
const pixelTarget = { x: 0.1, y: 0.2, width: 0.2, height: 0.1 }

// ---------------------------------------------------------------------------
// Reply parsing and the request sent to the model
// ---------------------------------------------------------------------------

const metadata = (extra: Partial<CaptureMetadata> = {}): CaptureMetadata => ({
  id: 'capture-test', capturedAt: Date.now(), displayId: 'two', displayName: 'Fixture', width: 1000, height: 500,
  bounds: { x: -2000, y: 120, width: 2000, height: 1000 }, cursor: { x: 500, y: 250 }, scaleFactor: 2, rotation: 0, ...extra
})

test('an element id is accepted only when it was on the list that was sent', () => {
  const offered = new Set(['e4', 'e11'])
  assert.deepEqual(parseHighlightReply('{"explanation":"Sign in is the big button.","elementId":"e11","target":null}', metadata(), offered),
    { explanation: 'Sign in is the big button.', captureId: 'capture-test', target: null, elementId: 'e11' })
  // No listed element matches: the pixel box still works, and carries no element id.
  assert.deepEqual(parseHighlightReply('{"explanation":"It is this icon.","elementId":null,"target":{"x1":100,"y1":100,"x2":300,"y2":150}}', metadata(), offered),
    { explanation: 'It is this icon.', captureId: 'capture-test', target: pixelTarget })
  assert.deepEqual(parseHighlightReply('{"explanation":"Which one?","elementId":null,"target":null}', metadata(), offered),
    { explanation: 'Which one?', captureId: 'capture-test', target: null })
  for (const id of ['e12', 'e999', 'E11', 'e11 ', '', '__proto__']) {
    assert.throws(() => parseHighlightReply(JSON.stringify({ explanation: 'Here.', elementId: id, target: null }), metadata(), offered),
      /not on the supplied list/, id)
  }
  // The element format is mandatory once a list was sent, and unavailable when none was.
  assert.throws(() => parseHighlightReply('{"explanation":"Here.","target":null}', metadata(), offered), /unexpected response fields/)
  assert.throws(() => parseHighlightReply('{"explanation":"Here.","elementId":"e11","target":null}', metadata()), /unexpected response fields/)
})

test('the compact element list is the top-ranked actionable elements, labels only', async () => {
  const service = new ContextService({ permission: () => 'granted', snapshot: () => fixtureText, displayIdFor: () => 'd' })
  const snapshot = await service.capture()
  const list = locateElements(snapshot)
  assert.deepEqual(list.map((el) => Object.keys(el)), list.map(() => ['id', 'kind', 'label', 'region']))
  assert.deepEqual(new Set(list.map((el) => el.id)), new Set(['e0', 'e4', 'e7', 'e9', 'e10', 'e11', 'e16']))
  assert.deepEqual(list.find((el) => el.id === 'e9'), { id: 'e9', kind: 'input', label: 'Password', region: 'main' })
  assert.equal(list.some((el) => el.kind === 'heading' || el.kind === 'text'), false)

  const big = structuredClone(snapshot)
  big.elements = Array.from({ length: 200 }, (_, index) => ({ ...snapshot.elements[11], id: 'e' + index, label: 'Button ' + index + ' ' + 'x'.repeat(200) }))
  const capped = locateElements(big)
  assert.equal(capped.length, 60)
  assert.equal(capped.every((el) => el.label.length <= 120), true)
  service.dispose()
})

test('locate sends the element list and asks for an id first, a pixel box second', async () => {
  const image: ScreenImage = { data: DATA, mediaType: 'image/jpeg', metadata: metadata({ id: 'local-capture-id' }) }
  const elements: LocateElement[] = [
    { id: 'e4', kind: 'link', label: 'Accounts', region: 'nav' }, { id: 'e11', kind: 'button', label: 'Sign in', region: 'main' }
  ]
  let reply = '{"explanation":"Sign in is here.","elementId":"e11","target":null}'
  const gateway = new ClaudeGateway(async (input, init) => {
    const body = await new Request(input, init).json()
    assert.match(body.system, /Prefer elementId/)
    assert.match(body.system, /only if no listed element matches/)
    assert.match(body.system, /untrusted/)
    assert.deepEqual(body.output_config.format.schema.required, ['explanation', 'elementId', 'target'])
    assert.equal(body.output_config.format.schema.additionalProperties, false)
    const text: string = body.messages[0].content[1].text
    assert.ok(text.endsWith(JSON.stringify(elements)))
    return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
  })
  const ask = () => gateway.locate('fake-test-key', 'claude-test', [{ role: 'user', content: 'Where do I sign in?' }], new AbortController().signal, image, elements)
  assert.deepEqual(await ask(), { explanation: 'Sign in is here.', captureId: 'local-capture-id', target: null, elementId: 'e11' })
  reply = '{"explanation":"Sign in is here.","elementId":"e12","target":null}'
  await assert.rejects(ask(), /not on the supplied list/)
})

// ---------------------------------------------------------------------------
// AX frame -> highlight rectangle
// ---------------------------------------------------------------------------

test('an accessibility frame maps to display-local points on a display with a non-zero origin', () => {
  const bounds = { x: -2000, y: 120, width: 2000, height: 1000 }
  const frame = { x: -1700, y: 570, width: 400, height: 48 }
  assert.deepEqual(mapFrame(frame, bounds), { local: { x: 300, y: 450, width: 400, height: 48 }, desktop: frame })
  // Awkward fractions come back without float dust.
  assert.deepEqual(mapFrame({ x: -1966.7, y: 153.3, width: 33.3, height: 21.1 }, bounds).local, { x: 33.3, y: 33.3, width: 33.3, height: 21.1 })
  // Partly off the display: clipped to what is visible on it.
  assert.deepEqual(mapFrame({ x: -100, y: 1000, width: 300, height: 400 }, bounds).local, { x: 1900, y: 880, width: 100, height: 120 })
  for (const off of [
    { x: 10, y: 200, width: 100, height: 40 }, { x: -1700, y: 0, width: 400, height: 100 },
    { x: -1700, y: 570, width: 0.5, height: 48 }, { x: Number.NaN, y: 570, width: 400, height: 48 }
  ]) assert.throws(() => mapFrame(off, bounds), /not on the captured display/)
})

interface Rig {
  controller: HighlightController
  display: DisplayGeometry
  clock: { now: number }
  calls: { draw: Rectangle[]; redraw: Rectangle[]; hide: number; observed: Rectangle[]; unobserved: number; lost: HighlightState[]; probes: Array<{ pid: number; path: number[] }> }
  timer: { interval: number; stopped: boolean; tick: () => Promise<void> }
  reading: { value: FrameReading | Error }
}
const anchor = (): ElementAnchor => ({ frame: { x: -1700, y: 570, width: 400, height: 48 }, pid: 4242, path: [1, 0, 6], role: 'AXButton' })
const seen = (extra: Partial<FrameReading> = {}): FrameReading => ({ frontmost: true, role: 'AXButton', frame: anchor().frame, ...extra })

function rig(options: { track?: boolean } = {}): Rig {
  const display: DisplayGeometry = { bounds: { x: -2000, y: 120, width: 2000, height: 1000 }, scaleFactor: 2, rotation: 0 }
  const clock = { now: 50_000 }
  const calls: Rig['calls'] = { draw: [], redraw: [], hide: 0, observed: [], unobserved: 0, lost: [], probes: [] }
  const timer: Rig['timer'] = { interval: 0, stopped: false, tick: async () => { throw new Error('tracking never started') } }
  const reading: Rig['reading'] = { value: seen() }
  const controller = new HighlightController({
    display: () => display,
    draw: (state) => { calls.draw.push(state.rectangle) },
    redraw: (state) => { calls.redraw.push(state.rectangle) },
    hide: () => { calls.hide++ },
    observeClick: (target) => { calls.observed.push(target); return () => { calls.unobserved++ } },
    now: () => clock.now,
    every: (interval, tick) => { timer.interval = interval; timer.tick = tick; timer.stopped = false; return () => { timer.stopped = true } },
    ...(options.track === false ? {} : {
      frameOf: async (pid: number, path: number[]) => {
        calls.probes.push({ pid, path })
        if (reading.value instanceof Error) throw reading.value
        return reading.value
      }
    })
  })
  controller.onLost((state) => calls.lost.push(state))
  return { controller, display, clock, calls, timer, reading }
}
const reply: HighlightReply = { explanation: 'Sign in is here.', captureId: 'capture-test', target: null, elementId: 'e11' }
function show(r: Rig, capture = metadata()) {
  const plan = r.controller.plan(reply, capture, 'task', r.controller.revision, anchor())!
  assert.equal(r.controller.present(plan), true)
  return plan
}

test('an element highlight uses the AX frame, in display points, on a scaleFactor 2 display', () => {
  const r = rig()
  const plan = show(r)
  assert.equal(highlightSource(plan), 'element_id')
  // 2x backing scale does not enter into it: AX frames and display bounds are both in points.
  assert.deepEqual(plan.state.rectangle, { x: 300, y: 450, width: 400, height: 48 })
  assert.deepEqual(plan.state.bounds, r.display.bounds)
  assert.deepEqual(r.calls.draw, [{ x: 300, y: 450, width: 400, height: 48 }])
  assert.deepEqual(r.calls.observed, [{ x: -1700, y: 570, width: 400, height: 48 }])
  assert.equal(r.timer.interval, 150)
  r.controller.dispose()
})

test('a tracked highlight ignores the 30 s screenshot age but still requires the same display geometry', () => {
  const old = metadata({ capturedAt: Date.now() - 5 * 60_000 })
  const tracked = rig()
  show(tracked, old)
  tracked.controller.clear()
  tracked.display.scaleFactor = 1
  assert.throws(() => tracked.controller.plan(reply, old, 'task', tracked.controller.revision, anchor()), /display changed/)
  tracked.display.scaleFactor = 2
  tracked.display.bounds = { ...tracked.display.bounds, x: 0 }
  assert.throws(() => tracked.controller.plan(reply, metadata(), 'task', tracked.controller.revision, anchor()), /display changed/)
  tracked.controller.dispose()

  // With no way to re-read the frame, an element highlight is a snapshot like any other.
  const untracked = rig({ track: false })
  assert.throws(() => untracked.controller.plan(reply, old, 'task', untracked.controller.revision, anchor()), /expired/)
  show(untracked)
  assert.equal(untracked.timer.interval, 0)
  // Pixel boxes keep the limit too.
  untracked.controller.clear()
  assert.throws(() => untracked.controller.plan({ ...reply, target: pixelTarget }, old, 'task', untracked.controller.revision), /expired/)
  untracked.controller.dispose()
})

test('tracking redraws when the element moves and re-arms the click target once it settles', async () => {
  const r = rig()
  show(r)
  await r.timer.tick()
  assert.deepEqual(r.calls.probes, [{ pid: 4242, path: [1, 0, 6] }])
  assert.deepEqual(r.calls.redraw, [], 'an unmoved element is not repainted')

  r.reading.value = seen({ frame: { x: -1700, y: 470, width: 400, height: 48 } })
  await r.timer.tick()
  assert.deepEqual(r.calls.redraw, [{ x: 300, y: 350, width: 400, height: 48 }])
  assert.deepEqual(r.controller.snapshot()!.rectangle, { x: 300, y: 350, width: 400, height: 48 })
  assert.equal(r.calls.unobserved, 1, 'the old click target is dropped as soon as the element moves')
  assert.equal(r.calls.observed.length, 1, 'no new observer per scroll frame')

  r.reading.value = seen({ frame: { x: -1700, y: 370, width: 400, height: 48 } })
  await r.timer.tick()
  assert.equal(r.calls.redraw.length, 2)
  assert.equal(r.calls.observed.length, 1)
  await r.timer.tick()
  assert.deepEqual(r.calls.observed.at(-1), { x: -1700, y: 370, width: 400, height: 48 })
  assert.equal(r.calls.redraw.length, 2)
  assert.deepEqual(r.calls.draw.length, 1, 'moves never go through the hide-and-show draw path')
  assert.deepEqual(r.calls.lost, [])
  r.controller.dispose()
  assert.equal(r.timer.stopped, true)
})

test('a tracked element that disappears for more than 1 s clears the highlight and reports it', async () => {
  const r = rig()
  const plan = show(r)
  r.reading.value = { frontmost: true, frame: null }
  await r.timer.tick()
  r.clock.now += 1000
  await r.timer.tick()
  assert.ok(r.controller.snapshot(), 'exactly one second is still within the grace period')
  r.clock.now += 1
  await r.timer.tick()
  assert.equal(r.controller.snapshot(), null)
  assert.deepEqual(r.calls.lost.map((state) => state.id), [plan.state.id])
  assert.equal(r.timer.stopped, true)
  assert.ok(r.calls.hide >= 1)
  r.controller.dispose()
})

test('a brief disappearance, a scroll off the display and a failed read all recover within the grace period', async () => {
  const r = rig()
  show(r)
  for (const lost of [{ frontmost: true, frame: null } as FrameReading, seen({ frame: { x: 400, y: 570, width: 400, height: 48 } }), new Error('AX timeout')]) {
    r.reading.value = lost
    await r.timer.tick()
    r.clock.now += 900
    await r.timer.tick()
    r.reading.value = seen()
    await r.timer.tick()
    r.clock.now += 900
  }
  assert.ok(r.controller.snapshot())
  assert.deepEqual(r.calls.lost, [])
  r.controller.dispose()
})

test('switching away from the app for more than 1 s, or a different element at the path, clears the highlight', async () => {
  for (const reading of [seen({ frontmost: false }), seen({ role: 'AXLink' })]) {
    const r = rig()
    show(r)
    r.reading.value = reading
    await r.timer.tick()
    r.clock.now += 600
    await r.timer.tick()
    assert.ok(r.controller.snapshot())
    r.clock.now += 401
    await r.timer.tick()
    assert.equal(r.controller.snapshot(), null)
    assert.equal(r.calls.lost.length, 1)
    r.controller.dispose()
  }
  // Coming back within the second keeps it.
  const back = rig()
  show(back)
  back.reading.value = seen({ frontmost: false })
  await back.timer.tick()
  back.clock.now += 800
  back.reading.value = seen()
  await back.timer.tick()
  back.clock.now += 5000
  await back.timer.tick()
  assert.ok(back.controller.snapshot())
  back.controller.dispose()
})

test('tracking stops quietly when the highlight is dismissed or the display changes', async () => {
  const dismissed = rig()
  show(dismissed)
  const stale = dismissed.timer.tick
  dismissed.controller.clear()
  assert.equal(dismissed.timer.stopped, true)
  dismissed.reading.value = { frontmost: true, frame: null }
  dismissed.clock.now += 5000
  await stale()
  assert.deepEqual(dismissed.calls.lost, [], 'a late tick after dismissal reports nothing')
  assert.equal(dismissed.calls.probes.length, 0)
  dismissed.controller.dispose()

  const moved = rig()
  show(moved)
  moved.display.bounds = { ...moved.display.bounds, y: 0 }
  await moved.timer.tick()
  assert.equal(moved.controller.snapshot(), null)
  assert.deepEqual(moved.calls.lost, [], 'a display change is not "the button moved"')
  moved.controller.dispose()
})

test('frame probes that are malformed read as a missing element', () => {
  assert.deepEqual(readFrame('{"frontmost":true,"role":"AXButton","frame":{"x":1,"y":2,"width":3,"height":4}}'),
    { frontmost: true, role: 'AXButton', frame: { x: 1, y: 2, width: 3, height: 4 } })
  assert.deepEqual(readFrame('{"frontmost":false,"frame":null}'), { frontmost: false, frame: null })
  for (const bad of ['not json', '{}', '{"frontmost":true,"frame":{"x":1,"y":2,"width":-3,"height":4}}', '{"frontmost":true,"frame":null,"label":"secret"}'])
    assert.deepEqual(readFrame(bad), { frontmost: true, frame: null })
})

// ---------------------------------------------------------------------------
// End to end through the coordinator
// ---------------------------------------------------------------------------

type Locate = (elements: LocateElement[] | undefined, captureId: string) => Promise<HighlightReply> | HighlightReply

async function fixture(locate: Locate, options: { permission?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-element-'))
  const file = join(directory, 'history.sqlite')
  const history = new HistoryStore(file)
  const credentials = new Credentials(directory, {
    available: async () => false, encrypt: async () => Buffer.alloc(0),
    decrypt: async () => ({ result: '', shouldReEncrypt: false })
  })
  await credentials.connect('fixture-key-not-real', false, [{ id: 'claude-test', label: 'Fixture' }])
  const bounds = { x: 0, y: 0, width: 2000, height: 1000 }
  const drawn: Rectangle[] = []
  const offered: Array<LocateElement[] | undefined> = []
  const cursors: Array<{ x: number; y: number } | undefined> = []
  const clock = { now: 0 }
  const reading: { value: FrameReading } = { value: { frontmost: true, role: 'AXButton', frame: { x: 300, y: 450, width: 400, height: 48 } } }
  let tick: () => Promise<void> = async () => {}
  const highlights = new HighlightController({
    display: () => ({ bounds }), hide: () => {}, draw: (state) => { drawn.push(state.rectangle) },
    frameOf: async () => reading.value, now: () => clock.now, every: (_interval, next) => { tick = next; return () => {} }
  })
  const contexts = new ContextService({
    permission: () => options.permission ?? 'granted', snapshot: () => fixtureText,
    displayIdFor: (_frame, cursor) => { cursors.push(cursor); return 'fixture' }
  })
  let captures!: PairedCapture
  const screens = new ScreenService({
    permission: () => 'granted',
    capture: async (captureOptions) => {
      const cursor = captureOptions?.cursor ?? { x: 640, y: 480 }
      cursors.push(cursor)
      await captures.snapshotContext(cursor)
      return { data: DATA, mediaType: 'image/jpeg', metadata: { displayId: 'fixture', displayName: 'Fixture', width: 1000, height: 500, bounds, cursor: { x: 100, y: 100 } } }
    }
  })
  captures = new PairedCapture(screens, contexts)
  const coordinator = new AssistantCoordinator({
    history, credentials, screens, highlights, contexts: captures, changed: () => {},
    gateway: {
      models: async () => [], reply: async () => 'Text reply',
      locate: async (_key, _model, _messages, _signal, image, elements) => { offered.push(elements); return locate(elements, image.metadata.id) }
    }
  })
  const events = () => {
    const db = new DatabaseSync(file)
    try { return JSON.stringify(db.prepare('SELECT type, payload_json FROM events').all()) } finally { db.close() }
  }
  return {
    coordinator, history, highlights, contexts, captures, drawn, offered, cursors, clock, reading, events,
    tick: () => tick(),
    ask: async () => {
      const preview = await captures.capture()
      const receipt = coordinator.send({ text: 'Where do I sign in?', captureId: preview.metadata.id, mode: 'highlight' })
      await settle()
      return { receipt, messages: () => history.detail(receipt.conversationId).messages }
    },
    close: () => { coordinator.dispose(); highlights.dispose(); screens.dispose(); contexts.dispose(); rmSync(directory, { recursive: true, force: true }) }
  }
}

test('a valid element id highlights the element frame and is logged as element_id without screen text', async () => {
  const f = await fixture((_elements, captureId) => ({ explanation: 'Use the wide orange control.', captureId, target: null, elementId: 'e11' }))
  try {
    await f.ask()
    assert.deepEqual(f.cursors, [{ x: 640, y: 480 }, { x: 640, y: 480 }], 'screenshot and snapshot share one cursor point')
    assert.equal(f.offered.length, 1)
    assert.deepEqual(f.offered[0]!.find((el) => el.id === 'e11'), { id: 'e11', kind: 'button', label: 'Sign in', region: 'main' })
    assert.deepEqual(f.drawn, [{ x: 300, y: 450, width: 400, height: 48 }])
    const events = f.events()
    assert.match(events, /\\"source\\":\\"element_id\\"/)
    assert.match(events, /prepared/)
    for (const text of ['Sign in', 'Password', 'Accounts', 'We use cookies', 'e11']) assert.equal(events.includes(text), false, text)
  } finally { f.close() }
})

test('an id that is not in that snapshot is rejected', async () => {
  const f = await fixture((_elements, captureId) => ({ explanation: 'It is over there.', captureId, target: null, elementId: 'e99' }))
  try {
    const { messages } = await f.ask()
    assert.deepEqual(f.drawn, [])
    assert.match(messages()[1].content, /No highlight: the reply named an item that is not on the captured screen/)
    assert.match(f.events(), /unknown_element/)
    assert.doesNotMatch(f.events(), /element_id|pixel_box/, 'no highlight was shown, so no source is logged')
  } finally { f.close() }
})

test('an id from an older generation is rejected even though the new snapshot has the same id', async () => {
  let release!: (reply: HighlightReply) => void
  let captureId = ''
  const f = await fixture((_elements, id) => { captureId = id; return new Promise<HighlightReply>((resolve) => { release = resolve }) })
  try {
    const pending = f.ask()
    await settle()
    // The screen is snapshotted again while the model is thinking: "e11" now belongs to a newer generation.
    const newer = await f.contexts.capture()
    assert.equal(newer.elements[11].id, 'e11')
    release({ explanation: 'Sign in is here.', captureId, target: null, elementId: 'e11' })
    const { messages } = await pending
    await settle()
    assert.deepEqual(f.drawn, [])
    assert.match(messages()[1].content, /No highlight: the view of the screen expired or was replaced/)
    assert.match(f.events(), /stale_element/)
  } finally { f.close() }
})

test('a discarded snapshot is no longer offered, and a rejected id falls back to the pixel box when one was given', async () => {
  let release!: (reply: HighlightReply) => void
  let captureId = ''
  const f = await fixture((_elements, id) => { captureId = id; return new Promise<HighlightReply>((resolve) => { release = resolve }) })
  try {
    const pending = f.ask()
    await settle()
    f.contexts.clear()
    assert.equal(f.captures.forCapture(captureId), undefined)
    release({ explanation: 'Sign in is here.', captureId, target: pixelTarget, elementId: 'e11' })
    await pending
    await settle()
    assert.deepEqual(f.drawn, [{ x: 200, y: 200, width: 400, height: 100 }])
    assert.match(f.events(), /\\"source\\":\\"pixel_box\\"/)
  } finally { f.close() }
})

test('without accessibility access the original pixel-box path runs unchanged', async () => {
  const f = await fixture((_elements, captureId) => ({ explanation: 'The control is here.', captureId, target: pixelTarget }), { permission: 'denied' })
  try {
    const { messages } = await f.ask()
    assert.deepEqual(f.offered, [undefined], 'no element list is sent')
    assert.deepEqual(f.drawn, [{ x: 200, y: 200, width: 400, height: 100 }])
    assert.equal(messages()[1].content, 'The control is here.')
    const events = f.events()
    assert.match(events, /\\"source\\":\\"pixel_box\\"/)
    assert.match(events, /\\"target\\":\{/)
    await f.tick()
    assert.ok(f.highlights.snapshot(), 'pixel-box highlights are not tracked')
  } finally { f.close() }
})

test('the model may still answer with a pixel box when no listed element matches', async () => {
  const f = await fixture((_elements, captureId) => ({ explanation: 'It is the unlabeled icon.', captureId, target: pixelTarget }))
  try {
    await f.ask()
    assert.equal(f.offered[0]!.length, 7)
    assert.deepEqual(f.drawn, [{ x: 200, y: 200, width: 400, height: 100 }])
    assert.match(f.events(), /\\"source\\":\\"pixel_box\\"/)
  } finally { f.close() }
})

test('losing a tracked element posts the ask-again message to the conversation', async () => {
  const f = await fixture((_elements, captureId) => ({ explanation: 'Sign in is here.', captureId, target: null, elementId: 'e11' }))
  try {
    const { messages } = await f.ask()
    assert.ok(f.coordinator.snapshot().highlight)
    f.reading.value = { frontmost: false, frame: null }
    await f.tick()
    f.clock.now += 1001
    await f.tick()
    assert.equal(f.coordinator.snapshot().highlight, undefined)
    assert.deepEqual(messages().map((message) => message.content), ['[Show me where] Where do I sign in?', 'Sign in is here.', HIGHLIGHT_LOST_MESSAGE])
    assert.equal(HIGHLIGHT_LOST_MESSAGE, 'The button moved off screen. Ask me again.')
    assert.match(f.events(), /highlight_lost/)
  } finally { f.close() }
})
