import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoicePreferences, defaultVoiceSettings } from '../src/main/voice/settings.ts'

test('voice is opt-in and only preferences survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-voice-settings-'))
  try {
    const preferences = new VoicePreferences(dir)
    assert.deepEqual(preferences.snapshot(), defaultVoiceSettings)
    const saved = { ...defaultVoiceSettings, enabled: true, microphoneId: 'fixture-input', shortcut: 'Shift+Control+A' }
    preferences.save(saved)
    assert.deepEqual(new VoicePreferences(dir).snapshot(), saved)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'voice-settings.json'), 'utf8'))).sort(), Object.keys(defaultVoiceSettings).sort())
    const copy = preferences.snapshot(); copy.enabled = false
    assert.equal(preferences.snapshot().enabled, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('voice rejects privileged/unsupported fields and unsafe shortcut or device values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-voice-settings-'))
  try {
    const preferences = new VoicePreferences(dir)
    for (const patch of [
      { spokenReplies: true }, { allowScreenCapture: true }, { microphoneId: '' }, { microphoneId: 'x'.repeat(257) },
      { shortcut: 'Space' }, { shortcut: 'Control+Control+Space' }, { shortcut: 'Control+; rm -rf /' },
      { enabled: 'yes' }, { source: 'voice' }, { transcript: 'unsaved' }, { executable: '/tmp/helper' }
    ]) assert.throws(() => preferences.save({ ...defaultVoiceSettings, ...patch }))
    assert.deepEqual(preferences.snapshot(), defaultVoiceSettings)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('malformed settings and storage failure leave voice disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-voice-settings-'))
  try {
    writeFileSync(join(dir, 'voice-settings.json'), '{"enabled":true}')
    const preferences = new VoicePreferences(dir)
    assert.equal(preferences.snapshot().enabled, false)
    assert.ok(preferences.warning)
    mkdirSync(join(dir, 'voice-settings.json.tmp'))
    assert.throws(() => preferences.save({ ...defaultVoiceSettings, enabled: true }), /saved/)
    assert.equal(preferences.snapshot().enabled, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
