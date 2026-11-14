import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { axSnapshotSchema, contextSnapshotSchema, type AxSnapshot, type ContextFrame } from '../src/shared/context-contracts.ts'
import { distilledPageSchema, RiskTier } from '../src/shared/simplifier-contracts.ts'
import { toDistilledPage } from '../src/main/context/distilled.ts'
import { ContextService, kindForRole, type ContextPort } from '../src/main/context/service.ts'
import { classifyPage, rankElements, riskTier } from '../src/main/simplifier/classify.ts'

const fixtureText = readFileSync(new URL('./fixtures/context-login.json', import.meta.url), 'utf8')
const fixture = (): AxSnapshot => JSON.parse(fixtureText)
const SECRET = 'hunter2-typed-password'

function harness(output: () => Promise<string> | string = () => fixtureText) {
  const clock = { now: 1_000_000 }
  const state = { permission: 'granted', calls: 0, frames: [] as ContextFrame[] }
  const port: ContextPort = {
    permission: () => state.permission,
    snapshot: () => { state.calls++; return output() },
    displayIdFor: (frame) => { state.frames.push(frame); return 'display-1' }
  }
  return { service: new ContextService(port, () => clock.now), clock, state }
}
const problem = (code: string) => (error: unknown) => (error as { code?: string }).code === code

test('the native JSON shape validates and is strict and bounded', () => {
  assert.equal(axSnapshotSchema.safeParse(fixture()).success, true)
  const empty = { app: { bundleId: '', name: '', pid: 0 }, window: { title: '', frame: { x: 0, y: 0, width: 0, height: 0 } }, elements: [] }
  assert.equal(axSnapshotSchema.safeParse(empty).success, true)

  const mutate = (change: (snapshot: any) => void) => { const copy = fixture(); change(copy); return axSnapshotSchema.safeParse(copy).success }
  assert.equal(mutate((s) => { s.extra = 1 }), false, 'unknown top-level key')
  assert.equal(mutate((s) => { s.elements[0].selectedText = 'x' }), false, 'unknown element key')
  assert.equal(mutate((s) => { s.elements[0].label = 'x'.repeat(301) }), false, 'label over 300')
  assert.equal(mutate((s) => { s.elements[6].value = 'x'.repeat(501) }), false, 'value over 500')
  assert.equal(mutate((s) => { s.elements[0].frame.width = -1 }), false, 'negative size')
  assert.equal(mutate((s) => { s.elements[0].frame.x = Number.POSITIVE_INFINITY }), false, 'non-finite frame')
  assert.equal(mutate((s) => { s.elements = Array.from({ length: 401 }, () => s.elements[0]) }), false, 'over 400 elements')
  assert.equal(mutate((s) => { s.focusedElementIndex = 17 }), false, 'focus index past the end')
  assert.equal(mutate((s) => { delete s.elements[0].secure }), false, 'missing secure flag')
})

test('a secure field can never carry a value through the schema', () => {
  const withValue = fixture()
  withValue.elements[9].value = SECRET
  assert.equal(axSnapshotSchema.safeParse(withValue).success, false)

  // Flagged by subrole or by role, a secure field that claims secure:false is rejected too.
  const unflagged = fixture()
  unflagged.elements[9].secure = false
  assert.equal(axSnapshotSchema.safeParse(unflagged).success, false)
  const byRole = fixture()
  byRole.elements[7] = { ...byRole.elements[7], role: 'AXSecureTextField', value: SECRET }
  assert.equal(axSnapshotSchema.safeParse(byRole).success, false)
})

test('roles map to the simplifier element kinds', () => {
  const expected: Record<string, string | null> = {
    AXButton: 'button', AXLink: 'link', AXTextField: 'input', AXSecureTextField: 'input', AXTextArea: 'textarea',
    AXComboBox: 'select', AXPopUpButton: 'select', AXCheckBox: 'checkbox', AXRadioButton: 'radio',
    AXHeading: 'heading', AXStaticText: 'text', AXWebArea: null, AXGroup: null, AXImage: null, toString: null
  }
  for (const [role, kind] of Object.entries(expected)) assert.equal(kindForRole(role), kind, role)
})

test('capture returns a validated snapshot with ids, kinds and metadata', async () => {
  const { service, state, clock } = harness()
  const snapshot = await service.capture()
  assert.equal(contextSnapshotSchema.safeParse(snapshot).success, true)
  assert.match(snapshot.id, /^[0-9a-f-]{36}$/)
  assert.equal(snapshot.capturedAt, clock.now)
  assert.equal(snapshot.displayId, 'display-1')
  assert.deepEqual(state.frames, [fixture().window.frame])
  assert.deepEqual(snapshot.elements.map((el) => el.id), fixture().elements.map((_, index) => 'e' + index))
  assert.deepEqual(snapshot.elements.map((el) => el.kind), [
    'button', null, null, null, 'link', 'heading', 'text', 'input', null, 'input', 'checkbox', 'button', null, 'text', 'button', null, 'link'
  ])
  assert.equal(snapshot.elements[snapshot.focusedElementIndex!].label, 'Password')
  assert.equal(service.get(snapshot.id), snapshot)
  assert.equal(service.element(snapshot.id, snapshot.generation, 'e11').label, 'Sign in')
  await assert.rejects(async () => service.element(snapshot.id, snapshot.generation, 'e99'), problem('context_element'))
  service.dispose()
})

test('a payload that leaks a secure value is refused and nothing is stored', async () => {
  const leaking = fixture()
  leaking.elements[9].value = SECRET
  const { service } = harness(() => JSON.stringify(leaking))
  await assert.rejects(service.capture(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'context_failed')
    assert.equal(String((error as Error).message).includes(SECRET), false)
    return true
  })
  const garbage = harness(() => 'not json')
  await assert.rejects(garbage.service.capture(), problem('context_failed'))
})

test('no secure value reaches the snapshot or the distilled page', async () => {
  const { service } = harness()
  const snapshot = await service.capture()
  const secure = snapshot.elements.filter((el) => el.secure)
  assert.equal(secure.length, 1)
  assert.equal('value' in secure[0], false)
  // Even a snapshot forged past the schema must not surface the value downstream.
  const forged = structuredClone(snapshot)
  forged.elements[9].value = SECRET
  forged.elements[9].label = ''
  assert.equal(JSON.stringify(toDistilledPage(forged)).includes(SECRET), false)
  service.dispose()
})

test('toDistilledPage satisfies distilledPageSchema and drives classify.ts unchanged', async () => {
  const { service } = harness()
  const snapshot = await service.capture()
  const page = toDistilledPage(snapshot)
  assert.equal(distilledPageSchema.safeParse(page).success, true)
  assert.equal(page.url, 'https://bank.example.com/login')
  assert.equal(page.title, 'Sign in - Example Bank')
  assert.equal(page.capturedAt, snapshot.capturedAt)
  assert.equal(page.mainText, 'Sign in to see your accounts.\nWe use cookies.')

  const byId = Object.fromEntries(page.elements.map((el) => [el.id, el]))
  // Containers, images and prose are not page elements; ids still point back into the snapshot.
  assert.deepEqual(Object.keys(byId), ['e0', 'e4', 'e5', 'e7', 'e9', 'e10', 'e11', 'e14', 'e16'])
  assert.equal(byId.e0.region, 'other', 'browser chrome is outside the web area')
  assert.equal(byId.e4.region, 'nav')
  assert.equal(byId.e4.href, 'https://bank.example.com/accounts')
  assert.equal(byId.e5.region, 'main')
  assert.equal(byId.e5.level, 1)
  assert.equal(byId.e5.label, 'Welcome back')
  assert.equal(byId.e7.region, 'main')
  assert.equal(byId.e9.inputType, 'password')
  assert.equal(byId.e11.region, 'main', 'leaving the navigation landmark restores main')
  assert.equal(byId.e14.region, 'dialog')
  assert.equal(byId.e16.region, 'footer')
  assert.equal(page.stats.totalElements, 17)
  assert.equal(page.stats.interactiveElements, 8)
  assert.equal(page.stats.maxNavDepth, 2)
  assert.ok(byId.e11.area > 0 && byId.e11.area < 1)
  assert.ok(Math.abs(byId.e11.top - 425 / 800) < 1e-9)

  assert.equal(classifyPage(page), 'login')
  assert.equal(riskTier(byId.e9, page), RiskTier.MoneyOrCredentials)
  assert.equal(riskTier(byId.e11, page), RiskTier.MoneyOrCredentials)
  assert.equal(riskTier(byId.e4, page), RiskTier.Navigate)
  const ranked = rankElements(page)
  assert.equal(ranked.some((el) => el.kind === 'heading'), false)
  assert.ok(ranked.findIndex((el) => el.id === 'e11') < ranked.findIndex((el) => el.id === 'e16'), 'main button outranks footer link')
  service.dispose()
})

test('toDistilledPage copes with native apps and long text', () => {
  const longText = 'x'.repeat(500)
  const native: AxSnapshot = {
    app: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', pid: 7 },
    window: { title: '', frame: { x: 0, y: 0, width: 0, height: 0 } },
    elements: [
      { role: 'AXHeading', label: '', value: 'Notes', frame: { x: 0, y: 0, width: 10, height: 10 }, secure: false, enabled: true, depth: 0 },
      { role: 'AXButton', label: '', frame: { x: 0, y: 0, width: 10, height: 10 }, secure: false, enabled: true, depth: 0 },
      { role: 'AXTextArea', label: '', frame: { x: 0, y: 0, width: 10, height: 10 }, secure: false, enabled: true, depth: 0 },
      { role: 'AXSheet', label: 'Save', frame: { x: 0, y: 0, width: 10, height: 10 }, secure: false, enabled: true, depth: 0 },
      { role: 'AXButton', label: 'Save', frame: { x: 0, y: 0, width: 10, height: 10 }, secure: false, enabled: true, depth: 1 },
      ...Array.from({ length: 60 }, () => ({ role: 'AXStaticText', label: '', value: longText, frame: { x: 0, y: 0, width: 10, height: 10 }, secure: false, enabled: true, depth: 0 }))
    ]
  }
  const snapshot = {
    ...axSnapshotSchema.parse(native), id: '00000000-0000-4000-8000-000000000000', capturedAt: 5, displayId: '1', generation: 1,
    elements: native.elements.map((el, index) => ({ ...el, id: 'e' + index, kind: kindForRole(el.role) }))
  }
  const page = toDistilledPage(snapshot)
  assert.equal(distilledPageSchema.safeParse(page).success, true)
  assert.equal(page.title, 'TextEdit')
  assert.equal(page.url, '')
  assert.equal(page.mainText.length, 20000)
  // The heading falls back to its text, the unlabelled button is dropped, the unlabelled field is kept.
  assert.deepEqual(page.elements.map((el) => [el.id, el.label, el.region]), [
    ['e0', 'Notes', 'other'], ['e2', '', 'other'], ['e4', 'Save', 'dialog']
  ])
  assert.equal(page.elements.every((el) => el.area === 0 && el.top === 0), true, 'a zero-size window never divides by zero')
})

test('snapshots expire after 30 seconds', async () => {
  const { service, clock } = harness()
  const snapshot = await service.capture()
  clock.now += 30_000
  assert.equal(service.get(snapshot.id), snapshot)
  clock.now += 1
  assert.throws(() => service.get(snapshot.id), problem('context_expired'))
  assert.throws(() => service.element(snapshot.id, snapshot.generation, 'e0'), problem('context_expired'))
  service.dispose()
})

test('element ids from an older generation are rejected', async () => {
  const { service } = harness()
  const first = await service.capture()
  const second = await service.capture()
  assert.ok(second.generation > first.generation)
  assert.notEqual(second.id, first.id)
  assert.throws(() => service.get(first.id), problem('context_expired'))
  assert.throws(() => service.element(first.id, first.generation, 'e0'), problem('context_expired'))
  // The right snapshot with a stale generation is refused as well: "e0" means something else now.
  assert.throws(() => service.element(second.id, first.generation, 'e0'), problem('context_expired'))
  assert.equal(service.element(second.id, second.generation, 'e0').label, 'Reload')
  service.discard(second.id)
  assert.throws(() => service.get(second.id), problem('context_expired'))
  service.dispose()
})

test('permission, overlap, cancellation and disposal are enforced', async () => {
  const denied = harness()
  denied.state.permission = 'denied'
  await assert.rejects(denied.service.capture(), problem('context_permission'))
  assert.equal(denied.state.calls, 0, 'nothing is read without permission')

  let release!: (value: string) => void
  const slow = harness(() => new Promise<string>((resolve) => { release = resolve }))
  const inFlight = slow.service.capture()
  await assert.rejects(slow.service.capture(), problem('busy'))
  slow.service.clear()
  release(fixtureText)
  await assert.rejects(inFlight, problem('context_canceled'))

  const closing = harness(() => new Promise<string>((resolve) => { release = resolve }))
  const pending = closing.service.capture()
  closing.service.dispose()
  release(fixtureText)
  await assert.rejects(pending, problem('closed'))
  await assert.rejects(closing.service.capture(), problem('closed'))
})
