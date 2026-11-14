import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ShakePreferences } from '../src/main/gestures/settings.ts'
import { DEFAULT_SHAKE_INSTRUCTION } from '../src/shared/shake-contracts.ts'

test('shake is off by default and saved opt-in instruction survives restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-shake-settings-'))
  try {
    const settings = new ShakePreferences(directory)
    assert.deepEqual(settings.snapshot(), { enabled: false, instruction: DEFAULT_SHAKE_INSTRUCTION })
    settings.save({ enabled: true, instruction: '  Explain the error near the cursor.  ' })
    assert.deepEqual(new ShakePreferences(directory).snapshot(), { enabled: true, instruction: 'Explain the error near the cursor.' })
    settings.save({ enabled: false, instruction: DEFAULT_SHAKE_INSTRUCTION })
    assert.equal(new ShakePreferences(directory).snapshot().enabled, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('highlight action persists while unknown actions are rejected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-shake-settings-'))
  try {
    const settings = new ShakePreferences(directory)
    settings.save({ enabled: false, instruction: 'Show the save control', mode: 'highlight' })
    assert.equal(new ShakePreferences(directory).snapshot().mode, 'highlight')
    assert.throws(() => settings.save({ enabled: true, instruction: 'test', mode: 'execute-code' }), /instruction/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('malformed settings fail closed and invalid updates preserve previous preferences', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-shake-settings-'))
  try {
    writeFileSync(join(directory, 'shake-settings.json'), '{"enabled":true}')
    const settings = new ShakePreferences(directory)
    assert.equal(settings.snapshot().enabled, false)
    assert.ok(settings.snapshot().warning)
    for (const value of [
      { enabled: true, instruction: ' ' }, { enabled: 'yes', instruction: 'test' },
      { enabled: true, instruction: 'x'.repeat(4001) }, { enabled: true, instruction: 'test', extra: 'invalid' }
    ]) assert.throws(() => settings.save(value), /instruction/)
    settings.save({ enabled: false, instruction: DEFAULT_SHAKE_INSTRUCTION })
    assert.equal(settings.snapshot().warning, undefined)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('settings sanitize known credentials and failed writes do not enable detection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-shake-settings-'))
  try {
    const settings = new ShakePreferences(directory)
    settings.save({ enabled: false, instruction: 'Explain password=not-a-real-secret on screen' })
    assert.ok(!readFileSync(join(directory, 'shake-settings.json'), 'utf8').includes('not-a-real-secret'))
    mkdirSync(join(directory, 'shake-settings.json.tmp'))
    assert.throws(() => settings.save({ enabled: true, instruction: 'New instruction' }), /saved/)
    assert.equal(settings.snapshot().enabled, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
