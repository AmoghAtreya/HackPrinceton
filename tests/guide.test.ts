import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GuideSession } from '../src/main/assistant/guide.ts'
import { GUIDE_IDLE_MS, GUIDE_MAX_STEPS, guideGoal, isNextStep, isShowAgain } from '../src/shared/guide-contracts.ts'

test('a guide remembers its steps in order and which request is on screen', () => {
  const guide = new GuideSession({ conversationId: 'c1', goal: 'attach a photo', spoken: true })
  assert.deepEqual(guide.progress(), { goal: 'attach a photo', done: [] })
  assert.equal(guide.shown('t1', 'Click Compose.'), 1)
  assert.equal(guide.shown('t2', 'Click the paperclip.'), 2)
  assert.deepEqual(guide.progress().done, ['Click Compose.', 'Click the paperclip.'])
  assert.equal(guide.current('t2'), true)
  assert.equal(guide.current('t1'), false, 'a click on an earlier step is ignored')
  assert.deepEqual(guide.snapshot(), { conversationId: 'c1', goal: 'attach a photo', step: 2, taskId: 't2', spoken: true })
})

test('a guide ends after the step limit or a long idle time', () => {
  let now = 1000
  const guide = new GuideSession({ conversationId: 'c1', goal: 'g', spoken: false, now: () => now })
  for (let step = 1; step < GUIDE_MAX_STEPS; step++) guide.shown('t' + step, 'Step.')
  assert.equal(guide.exhausted, false)
  guide.shown('last', 'Step.')
  assert.equal(guide.exhausted, true)
  now += GUIDE_IDLE_MS
  assert.equal(guide.expired, false)
  now += 1
  assert.equal(guide.expired, true)
  guide.attempted('retry')
  assert.equal(guide.expired, false, 'trying again counts as activity')
  assert.equal(guide.current('retry'), true)
})

test('"next", "done" and "what now" ask for the next step; real requests do not', () => {
  for (const text of ['next', 'Next.', 'Done!', 'okay', 'OK, done', 'I did it', "what's next?", 'What now?', 'Okay next please', 'keep going', 'ready'])
    assert.equal(isNextStep(text), true, text)
  for (const text of ['next week is my birthday', 'done with this, open my email', 'what is next to the button', 'stop', 'help me print', ''])
    assert.equal(isNextStep(text), false, text)
})

test('plain requests for step-by-step help start a guide; explanations and vague asks do not', () => {
  assert.equal(guideGoal('Help me attach a photo to this email'), 'attach a photo to this email')
  assert.equal(guideGoal('Can you walk me through sending this?'), 'sending this')
  assert.equal(guideGoal('show me how to reply to this message please'), 'reply to this message')
  assert.equal(guideGoal('Okay help me to change my password'), 'change my password')
  for (const text of ['help me', 'help me with this', 'help me understand this page', 'how do I print this', 'help me print', 'what is this'])
    assert.equal(guideGoal(text), null, text)
})

test('"show me", "where is it" and "give me an arrow" ask for the current box again', () => {
  for (const text of ['Show me', 'can you show me?', 'Where is it?', 'give me an arrow please', 'I can\'t see it', 'point to it'])
    assert.equal(isShowAgain(text), true, text)
  for (const text of ['show me my orders', 'next', 'where is my package', 'help me print this'])
    assert.equal(isShowAgain(text), false, text)
})
