import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ShakeDetector, type CursorSample } from '../src/main/gestures/detector.ts'
import { ShakeMonitor } from '../src/main/gestures/monitor.ts'

// Synthetic mouse/trackpad-like traces, never a recording of the user's pointer.
function trace(start = 1000, vertical = false): CursorSample[] {
  return Array.from({ length: 33 }, (_, i) => [0, 40, 80, 40][i % 4]).map((n, i) => ({
    x: vertical ? -200 : n - 300, y: vertical ? n : 200, at: start + i * 33, displayId: 'one'
  }))
}

test('horizontal and vertical deliberate traces trigger exactly once', () => {
  for (const vertical of [false, true]) {
    const detector = new ShakeDetector()
    assert.equal(trace(1000, vertical).filter((point) => detector.feed(point)).length, 1)
  }
})
test('shake waits for a full second before triggering', () => {
  const detector = new ShakeDetector()
  const points = trace()
  assert.ok(points.filter((point) => point.at < 2000).every((point) => !detector.feed(point)))
  assert.equal(detector.feed({ ...points[32], at: 2000 }), true)
})
test('navigation jitter slow motion and pointer warps do not trigger', () => {
  const traces = [
    Array.from({ length: 35 }, (_, i) => ({ x: i * 15, y: i * 4, at: 1000 + i * 33, displayId: 'one' })),
    Array.from({ length: 35 }, (_, i) => ({ x: i % 2 ? 4 : -4, y: i % 3, at: 1000 + i * 33, displayId: 'one' })),
    trace().map((point, i) => ({ ...point, at: 1000 + i * 200 })),
    trace().map((point, i) => ({ ...point, x: i % 2 ? 1200 : 0 }))
  ]
  for (const points of traces) {
    const detector = new ShakeDetector()
    assert.ok(points.every((point) => !detector.feed(point)))
  }
})
test('cooldown blocks repeated gestures then permits a later deliberate shake', () => {
  const detector = new ShakeDetector()
  assert.equal(trace(1000).filter((point) => detector.feed(point)).length, 1)
  assert.equal(trace(1800).filter((point) => detector.feed(point)).length, 0)
  assert.equal(trace(5000).filter((point) => detector.feed(point)).length, 1)
})
test('display changes invalid coordinates and long sampling gaps reset partial gestures', () => {
  for (const interruption of ['display', 'gap', 'invalid', 'reset']) {
    const detector = new ShakeDetector()
    const points = trace()
    points.slice(0, 7).forEach((point) => assert.equal(detector.feed(point), false))
    if (interruption === 'reset') detector.reset()
    if (interruption === 'invalid') detector.feed({ ...points[7], x: NaN })
    const remaining = points.slice(7).map((point) => ({
      ...point, displayId: interruption === 'display' ? 'two' : point.displayId,
      at: point.at + (interruption === 'gap' ? 2000 : 0)
    }))
    assert.ok(remaining.every((point) => !detector.feed(point)))
  }
})
test('monitor opt-out drag suppression sleep reset and disposal prevent triggers', () => {
  let enabled = false
  let suppressed = false
  let sample = trace()[0]
  const triggered: unknown[] = []
  const monitor = new ShakeMonitor({
    enabled: () => enabled, suppressed: () => suppressed, sample: () => sample,
    trigger: (value) => triggered.push(value)
  })
  function feed(start: number) { for (const point of trace(start)) { sample = point; monitor.poll() } }
  feed(1000)
  assert.equal(triggered.length, 0)
  enabled = true; suppressed = true; feed(2000)
  assert.equal(triggered.length, 0)
  suppressed = false; monitor.pause(); feed(3000)
  assert.equal(triggered.length, 0)
  monitor.resume(); feed(4000)
  assert.equal(triggered.length, 1)
  assert.deepEqual(triggered[0], { point: { x: -260, y: 200 }, displayId: 'one', triggeredAt: 5023 })
  monitor.dispose(); feed(9000)
  assert.equal(triggered.length, 1)
})
