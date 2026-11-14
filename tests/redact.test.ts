import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { PairedCapture } from '../src/main/context/paired-capture.ts'
import { ContextService } from '../src/main/context/service.ts'
import { blackout, encodeRedacted, privateFrames, toImageRegions } from '../src/main/screen/redact.ts'
import { ScreenService } from '../src/main/screen/service.ts'
import type { AxSnapshot, ContextSnapshot } from '../src/shared/context-contracts.ts'
import { redactionNotice } from '../src/shared/screen-contracts.ts'

const login = (): AxSnapshot => JSON.parse(readFileSync(new URL('./fixtures/context-login.json', import.meta.url), 'utf8'))
async function snapshotOf(raw: AxSnapshot): Promise<ContextSnapshot> {
  const service = new ContextService({ permission: () => 'granted', snapshot: () => JSON.stringify(raw), displayIdFor: () => 'fixture' })
  try { return await service.capture() } finally { service.dispose() }
}
const field = (label: string, y: number, extra: Record<string, unknown> = {}) => ({
  role: 'AXTextField', label, frame: { x: 300, y, width: 400, height: 40 }, secure: false, enabled: true, depth: 1, path: [1, 0, 9, y], ...extra
})

// ---------------------------------------------------------------------------
// Which fields are private
// ---------------------------------------------------------------------------

test('secure fields and fields labelled like passwords, cards or SSNs are private; nothing else is', async () => {
  const raw = login()
  raw.elements.push(
    field('Card number', 500), field('CVV', 600), field('Social Security number', 650),
    // A password shown in clear (the "show password" toggle) is an ordinary text field with a telling label.
    field('Password', 700), field('PIN', 750),
    field('Full name', 800), field('Search', 850),
    { ...field('Reset your password', 900), role: 'AXLink' }, { ...field('Card number help', 950), role: 'AXStaticText', value: 'Card number help' }
  )
  const frames = privateFrames(await snapshotOf(raw))!
  assert.deepEqual(frames.map((frame) => frame.y), [360, 500, 600, 650, 700, 750])
  // "Sign in" matches the credentials pattern but is a button, not a field holding anything private.
  assert.equal(frames.some((frame) => frame.y === 450), false)
  assert.deepEqual(frames[0], { x: 300, y: 360, width: 400, height: 40 })
})

test('a snapshot that read nothing cannot vouch for the screen', async () => {
  assert.equal(privateFrames(undefined), null)
  assert.equal(privateFrames(await snapshotOf({ app: { bundleId: '', name: '', pid: 0 }, window: { title: '', frame: { x: 0, y: 0, width: 0, height: 0 } }, elements: [] })), null)
  const none = login()
  none.elements = none.elements.filter((element) => !element.secure)
  none.focusedElementIndex = undefined
  assert.deepEqual(privateFrames(await snapshotOf(JSON.parse(JSON.stringify(none)))), [], 'a readable screen with no private fields is a real zero')
})

// ---------------------------------------------------------------------------
// Global points -> image pixels
// ---------------------------------------------------------------------------

test('frames map to image pixels with 4 px of padding at scale 1, scale 2 and on downscaled offset displays', () => {
  const frame = { x: 300, y: 360, width: 400, height: 40 }
  // Scale 1: one image pixel per point.
  assert.deepEqual(toImageRegions([frame], { bounds: { x: 0, y: 0, width: 1280, height: 800 }, width: 1280, height: 800 }),
    [{ x: 296, y: 356, width: 408, height: 48 }])
  // Scale 2 on a display to the right of the primary: two pixels per point, origin removed first.
  assert.deepEqual(toImageRegions([{ ...frame, x: 1740 }], { bounds: { x: 1440, y: 0, width: 1280, height: 800 }, width: 2560, height: 1600 }),
    [{ x: 596, y: 716, width: 808, height: 88 }])
  // A display left of and below the primary, captured at half size (what the 1280 px budget does to a big screen).
  assert.deepEqual(toImageRegions([{ x: -1700, y: 570, width: 400, height: 48 }], { bounds: { x: -2000, y: 120, width: 2000, height: 1000 }, width: 1000, height: 500 }),
    [{ x: 146, y: 221, width: 208, height: 32 }])
  // Different horizontal and vertical scales, and fractional edges grow outward so no sliver is left showing.
  assert.deepEqual(toImageRegions([{ x: 10.4, y: 20.6, width: 99.3, height: 30.2 }], { bounds: { x: 0, y: 0, width: 1000, height: 1000 }, width: 1500, height: 750 }),
    [{ x: 11, y: 11, width: 158, height: 32 }])
  assert.deepEqual(toImageRegions([frame], { bounds: { x: 0, y: 0, width: 1280, height: 800 }, width: 1280, height: 800 }, 0), [frame])
})

test('regions are clipped at the image edges and fields off the display are dropped', () => {
  const geometry = { bounds: { x: 100, y: 50, width: 800, height: 600 }, width: 800, height: 600 }
  assert.deepEqual(toImageRegions([
    { x: 90, y: 40, width: 50, height: 30 },      // over the top-left corner
    { x: 880, y: 640, width: 100, height: 100 },  // over the bottom-right corner
    { x: 100, y: 50, width: 800, height: 600 },   // the whole display
    { x: 400, y: 300, width: 10, height: 10 }
  ], geometry), [
    { x: 0, y: 0, width: 44, height: 24 }, { x: 776, y: 586, width: 24, height: 14 },
    { x: 0, y: 0, width: 800, height: 600 }, { x: 296, y: 246, width: 18, height: 18 }
  ])
  // Padding must not pull in a field that lies entirely on a neighbouring display, even one touching the edge.
  assert.deepEqual(toImageRegions([
    { x: 0, y: 300, width: 100, height: 40 }, { x: 900, y: 300, width: 100, height: 40 },
    { x: 400, y: 0, width: 100, height: 50 }, { x: 400, y: 650, width: 100, height: 40 },
    { x: 400, y: 300, width: 0, height: 40 }, { x: Number.NaN, y: 300, width: 10, height: 10 }
  ], geometry), [])
  assert.throws(() => toImageRegions([], { bounds: { x: 0, y: 0, width: 0, height: 600 }, width: 800, height: 600 }), /Invalid screen image/)
})

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

const WIDTH = 20
const HEIGHT = 10
const filled = () => new Uint8Array(WIDTH * HEIGHT * 4).fill(0xab)
const pixel = (bitmap: Uint8Array, x: number, y: number) => Array.from(bitmap.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 4))
const inside = (region: { x: number; y: number; width: number; height: number }, x: number, y: number) =>
  x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height

test('every pixel inside a region is zeroed and every pixel outside is untouched', () => {
  const bitmap = filled()
  const regions = [{ x: 5, y: 2, width: 6, height: 4 }, { x: 17, y: 8, width: 10, height: 10 }, { x: -3, y: -3, width: 5, height: 4 }]
  blackout(bitmap, WIDTH, HEIGHT, regions)
  let blacked = 0
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const expected = regions.some((region) => inside(region, x, y))
    assert.deepEqual(pixel(bitmap, x, y), expected ? [0, 0, 0, 255] : [0xab, 0xab, 0xab, 0xab], `pixel ${x},${y}`)
    if (expected) blacked++
  }
  assert.equal(blacked, 6 * 4 + 3 * 2 + 2 * 1)
  assert.throws(() => blackout(new Uint8Array(10), WIDTH, HEIGHT, regions), /could not be checked/)
})

test('the encoder only ever receives the bitmap after the private pixels are gone', () => {
  const geometry = { bounds: { x: 0, y: 0, width: WIDTH, height: HEIGHT }, width: WIDTH, height: HEIGHT }
  const secret = { x: 8, y: 4, width: 4, height: 2 }
  const bitmap = filled()
  let seen = 0
  const result = encodeRedacted(bitmap, geometry, [secret, { x: 500, y: 500, width: 10, height: 10 }], (pixels) => {
    seen++
    // The field plus its 4 px of padding: x 4..15, y 0..9.
    for (let y = 0; y < HEIGHT; y++) for (let x = 4; x < 16; x++) assert.deepEqual(pixel(pixels, x, y), [0, 0, 0, 255])
    assert.deepEqual(pixel(pixels, 3, 5), [0xab, 0xab, 0xab, 0xab])
    assert.deepEqual(pixel(pixels, 16, 5), [0xab, 0xab, 0xab, 0xab])
    return Buffer.from('encoded-after-redaction')
  })
  assert.equal(seen, 1)
  assert.deepEqual(result, { bytes: Buffer.from('encoded-after-redaction'), redactedRegions: 1 }, 'only regions that landed on the image are counted')
  assert.equal(encodeRedacted(filled(), geometry, [], () => Buffer.alloc(1)).redactedRegions, 0)

  // The check failed: the image is still produced, untouched, and says it was not checked.
  const unchecked = filled()
  const failed = encodeRedacted(unchecked, geometry, null, (pixels) => { assert.deepEqual(pixels, filled()); return Buffer.from('x') })
  assert.equal(failed.redactedRegions, null)
  // A bitmap whose size does not match cannot be redacted reliably, so it is never encoded.
  assert.throws(() => encodeRedacted(new Uint8Array(12), geometry, [secret], () => { throw new Error('must not encode') }), /could not be checked/)
})

// ---------------------------------------------------------------------------
// The capture path
// ---------------------------------------------------------------------------

function screens(redactedRegions: unknown) {
  return new ScreenService({
    permission: () => 'granted',
    capture: async () => ({ data: Buffer.from('jpeg').toString('base64'), mediaType: 'image/jpeg' as const,
      metadata: { displayId: 'fixture', displayName: 'Fixture', width: 100, height: 50, bounds: { x: 0, y: 0, width: 100, height: 50 },
        cursor: { x: 1, y: 1 }, ...(redactedRegions === undefined ? {} : { redactedRegions }) } as never })
  })
}

test('an image that did not come out of the redaction step is discarded, not previewed or sent', async () => {
  for (const missing of [undefined, -1, 1.5, '2', Number.NaN]) {
    const service = screens(missing)
    await assert.rejects(service.capture(), (error: unknown) => (error as { code?: string }).code === 'capture_failed' && /not checked for private fields/.test((error as Error).message), String(missing))
    service.dispose()
  }
  for (const checked of [0, 2, null]) {
    const service = screens(checked)
    const preview = await service.capture()
    assert.equal(preview.metadata.redactedRegions, checked)
    assert.equal(service.take(preview.metadata.id).metadata.redactedRegions, checked)
    service.dispose()
  }
})

test('the capture port gets its frames from a snapshot taken with the screenshot, or null when that fails', async () => {
  for (const [permission, expected] of [['granted', [{ x: 300, y: 360, width: 400, height: 40 }]], ['denied', null]] as const) {
    const contexts = new ContextService({ permission: () => permission, snapshot: () => JSON.stringify(login()), displayIdFor: () => 'fixture' })
    let captures!: PairedCapture
    let frames: unknown = 'never asked'
    const service = new ScreenService({
      permission: () => 'granted',
      capture: async () => {
        frames = await captures.privateFields({ x: 10, y: 10 })
        const redacted = encodeRedacted(new Uint8Array(1280 * 800 * 4), { bounds: { x: 0, y: 0, width: 1280, height: 800 }, width: 1280, height: 800 },
          frames as never, () => Buffer.from('jpeg'))
        return { data: redacted.bytes.toString('base64'), mediaType: 'image/jpeg' as const,
          metadata: { displayId: 'fixture', displayName: 'Fixture', width: 1280, height: 800, bounds: { x: 0, y: 0, width: 1280, height: 800 },
            cursor: { x: 1, y: 1 }, redactedRegions: redacted.redactedRegions } }
      }
    })
    captures = new PairedCapture(service, contexts)
    const preview = await captures.capture()
    assert.deepEqual(frames, expected)
    assert.equal(preview.metadata.redactedRegions, expected ? 1 : null)
    service.dispose(); contexts.dispose()
  }
  // No accessibility module at all behaves like a failed check.
  assert.equal(await new PairedCapture({ capture: async () => { throw new Error('unused') }, clear() {} }).privateFields({ x: 0, y: 0 }), null)
})

test('history keeps the count and nothing about where the fields were', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-redact-'))
  const file = join(directory, 'history.sqlite')
  const history = new HistoryStore(file)
  try {
    history.begin('[Screen explanation] What is this?', 'claude-test', undefined, {
      id: '00000000-0000-4000-8000-000000000001', capturedAt: 1, displayId: 'fixture', displayName: 'Fixture', width: 1280, height: 800,
      bounds: { x: 0, y: 0, width: 1280, height: 800 }, cursor: { x: 1, y: 1 }, redactedRegions: 2
    })
    const db = new DatabaseSync(file)
    const payload = JSON.parse((db.prepare("SELECT payload_json FROM events WHERE type='request_started'").get() as { payload_json: string }).payload_json)
    db.close()
    assert.equal(payload.capture.redactedRegions, 2)
    assert.deepEqual(Object.keys(payload.capture).sort(), ['bounds', 'capturedAt', 'cursor', 'displayId', 'displayName', 'height', 'id', 'redactedRegions', 'width'])
  } finally { history.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('the preview line says how many fields were hidden, or that the check failed', () => {
  assert.equal(redactionNotice(2), 'Hid 2 private fields')
  assert.equal(redactionNotice(1), 'Hid 1 private field')
  assert.equal(redactionNotice(0), '')
  assert.equal(redactionNotice(null), 'Couldn’t check for private fields')
})
