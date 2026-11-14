import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { AssistantCoordinator } from '../src/main/assistant/coordinator.ts'
import { HistoryStore } from '../src/main/assistant/history.ts'
import { Credentials } from '../src/main/assistant/credentials.ts'
import { ScreenService } from '../src/main/screen/service.ts'
import { HighlightController } from '../src/main/screen/highlight.ts'
import type { GuideProgress, HighlightReply } from '../src/shared/highlight-contracts.ts'
import type { AssistantRoute } from '../src/shared/flight-contracts.ts'

const target = { x: 0.1, y: 0.2, width: 0.2, height: 0.1 }

/** A coordinator whose model starts a guide and then answers each step from `steps`. */
async function fixture(steps: Array<Omit<HighlightReply, 'captureId'>>, route: AssistantRoute = { kind: 'guide', goal: 'attach a photo' }) {
  const directory = mkdtempSync(join(tmpdir(), 'triage-guide-'))
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, {
    available: async () => false, encrypt: async () => Buffer.alloc(0), decrypt: async () => ({ result: '', shouldReEncrypt: false })
  })
  await credentials.connect('fixture-key-not-real', false, [{ id: 'claude-test', label: 'Fixture' }])
  const bounds = { x: 0, y: 0, width: 2000, height: 1000 }
  let click: (() => void) | undefined
  let drawn = 0
  const asked: GuideProgress[] = []
  const highlights = new HighlightController({
    display: () => ({ bounds }), hide: () => {}, draw: () => { drawn++ },
    observeClick: (_target, clicked) => { click = clicked; return () => { click = undefined } }
  })
  const screens = new ScreenService({
    permission: () => 'granted', capture: async () => ({
      data: Buffer.from('not-a-real-screenshot').toString('base64'), mediaType: 'image/jpeg',
      metadata: { displayId: 'fixture', redactedRegions: 0, displayName: 'Fixture', width: 1000, height: 500, bounds, cursor: { x: 100, y: 100 } }
    })
  })
  const coordinator = new AssistantCoordinator({
    history, credentials, screens, highlights, changed: () => {}, guideClickDelay: 5,
    captureScreen: () => screens.capture(),
    gateway: {
      models: async () => [], reply: async () => 'Text reply',
      route: async (_key, _model, messages) => messages.at(-1)!.content.includes('weather') ? { kind: 'reply', text: 'Sunny.' } : route,
      locate: async (_key, _model, _messages, _signal, image, _elements, _guidance, guide) => {
        asked.push(guide!)
        return { ...steps[asked.length - 1], captureId: image.metadata.id }
      }
    }
  })
  const settle = async () => { for (let turn = 0; turn < 50 && coordinator.snapshot().active; turn++) await wait(2) }
  const replies = (conversationId: string) => history.detail(conversationId).messages.filter((message) => message.role === 'assistant').map((message) => message.content)
  return {
    coordinator, asked, settle, replies, click: () => click?.(), drawn: () => drawn,
    close: () => { coordinator.dispose(); highlights.dispose(); screens.dispose(); rmSync(directory, { recursive: true, force: true }) }
  }
}

test('a guide shows one outlined step, moves on when it is clicked, and ends when the goal is done', async () => {
  const f = await fixture([
    { explanation: 'Click Compose.', target },
    { explanation: 'Click the paperclip.', target },
    { explanation: 'Your photo is attached.', target: null, done: true }
  ])
  try {
    const receipt = f.coordinator.send({ text: 'help me attach a photo', source: 'voice' })
    await f.settle()
    assert.deepEqual(f.coordinator.snapshot().guide, { conversationId: receipt.conversationId, goal: 'attach a photo', step: 1, taskId: receipt.taskId, spoken: true })
    assert.equal(f.drawn(), 1)
    assert.deepEqual(f.replies(receipt.conversationId), ['Step 1: Click Compose.'])

    f.click()                      // the person clicks the outlined button
    await wait(20); await f.settle()
    assert.deepEqual(f.asked[1], { goal: 'attach a photo', done: ['Click Compose.'] }, 'the model is told what was already done')
    assert.equal(f.coordinator.snapshot().guide?.step, 2)
    assert.equal(f.drawn(), 2)

    f.coordinator.send({ text: 'Done!', conversationId: receipt.conversationId })   // typed "done" also means next
    await f.settle()
    assert.equal(f.coordinator.snapshot().guide, undefined, 'the guide is over')
    assert.equal(f.coordinator.snapshot().highlight, undefined)
    assert.deepEqual(f.replies(receipt.conversationId), ['Step 1: Click Compose.', 'Step 2: Click the paperclip.', 'Your photo is attached.'])
    assert.throws(() => f.coordinator.guideNext(), { code: 'no_guide' })
  } finally { f.close() }
})

test('asking something else, or Stop guiding, ends the guide', async () => {
  const f = await fixture([{ explanation: 'Click Compose.', target }, { explanation: 'Click Compose.', target }])
  try {
    const receipt = f.coordinator.send({ text: 'help me attach a photo' })
    await f.settle()
    assert.equal(f.coordinator.snapshot().guide?.spoken, false)
    f.coordinator.send({ text: 'what is the weather', conversationId: receipt.conversationId })
    await f.settle()
    assert.equal(f.coordinator.snapshot().guide, undefined)
    assert.equal(f.coordinator.snapshot().highlight, undefined)

    f.coordinator.send({ text: 'help me attach a photo' })
    await f.settle()
    assert.ok(f.coordinator.snapshot().highlight)
    f.coordinator.guideStop()
    assert.equal(f.coordinator.snapshot().guide, undefined)
    assert.equal(f.coordinator.snapshot().highlight, undefined)
  } finally { f.close() }
})

test('a step with nothing to point at is still shown, and Next step looks again', async () => {
  const f = await fixture([{ explanation: 'Type your message in the big box.', target: null }, { explanation: 'Click Send.', target }])
  try {
    const receipt = f.coordinator.send({ text: 'help me send a message' })
    await f.settle()
    assert.equal(f.drawn(), 0)
    assert.deepEqual(f.replies(receipt.conversationId), ['Step 1: Type your message in the big box.'])
    f.coordinator.guideNext()
    await f.settle()
    assert.equal(f.drawn(), 1)
    assert.equal(f.coordinator.snapshot().guide?.step, 2)
  } finally { f.close() }
})

test('"help me …" starts a guide without asking the router, so a long answer cannot replace it', async () => {
  const f = await fixture([{ explanation: 'Click Compose.', target }], { kind: 'reply', text: 'Step 1… Step 2… Step 3… (a long list)' })
  try {
    const receipt = f.coordinator.send({ text: 'Help me attach a photo to this email', source: 'voice' })
    await f.settle()
    assert.equal(f.coordinator.snapshot().guide?.goal, 'attach a photo to this email')
    assert.deepEqual(f.replies(receipt.conversationId), ['Step 1: Click Compose.'])
  } finally { f.close() }
})
