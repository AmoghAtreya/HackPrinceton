import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clampPosition, readPosition, writePosition } from '../src/main/position-store.ts'

test('clamps a saved position after its former display is disconnected', () => {
  assert.deepEqual(
    clampPosition({ x: 2400, y: -600 }, { x: 0, y: 25, width: 1440, height: 875 }, { width: 128, height: 144 }),
    { x: 1312, y: 25 }
  )
})

test('keeps coordinates in DIP and supports displays with negative origins', () => {
  const area = { x: -1920, y: -200, width: 1920, height: 1080 }
  const size = { width: 128, height: 144 }
  assert.deepEqual(clampPosition({ x: -1500, y: 150 }, area, size), { x: -1500, y: 150 })
  assert.deepEqual(clampPosition({ x: 10, y: 1000 }, area, size), { x: -128, y: 736 })
})

test('anchors safely when the work area is smaller than the companion', () => {
  assert.deepEqual(
    clampPosition({ x: 500, y: -500 }, { x: 10, y: 20, width: 80, height: 90 }, { width: 128, height: 144 }),
    { x: 10, y: 20 }
  )
})

test('position preferences survive replacement and malformed preferences recover', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-position-test-'))
  const file = join(directory, 'prefs', 'position.json')
  try {
    assert.equal(readPosition(file), undefined)
    writePosition(file, { x: 1529, y: 813 })
    assert.deepEqual(readPosition(file), { x: 1529, y: 813 })
    assert.equal(existsSync(file + '.tmp'), false)
    writePosition(file, { x: 1489, y: 777 })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { x: 1489, y: 777 })
    for (const invalid of ['not json', 'null', '[]', '{"x":"100","y":200}', '{"x":1e999,"y":0}']) {
      writeFileSync(file, invalid)
      assert.equal(readPosition(file), undefined)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
