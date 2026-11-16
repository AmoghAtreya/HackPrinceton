import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChromeFrontWatcher, isChrome } from '../src/main/chrome-front.ts'

test('only Chrome browser windows count, not Chrome web apps or other browsers', () => {
  assert.equal(isChrome('com.google.Chrome'), true)
  assert.equal(isChrome('com.google.Chrome.canary'), true)
  assert.equal(isChrome('com.google.Chrome.app.gmail'), false)
  assert.equal(isChrome('com.apple.Safari'), false)
  assert.equal(isChrome(''), false)
})

test('reports only changes, and reads false while disabled or failing', () => {
  let front = 'com.google.Chrome'
  let enabled = true
  const seen: boolean[] = []
  const watcher = new ChromeFrontWatcher({ read: () => { if (front === 'boom') throw new Error('x'); return front }, changed: (value) => seen.push(value), enabled: () => enabled })
  watcher.check(); watcher.check()
  assert.deepEqual(seen, [true])
  front = 'com.apple.Safari'; watcher.check()
  front = 'com.google.Chrome'; watcher.check()
  enabled = false; watcher.check()
  enabled = true; front = 'boom'; watcher.check()
  assert.deepEqual(seen, [true, false, true, false])
  watcher.stop()
  assert.equal(watcher.chromeInFront, false)
})
