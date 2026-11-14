import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VoiceKeyStore } from '../src/main/voice/voice-key.ts'

// Reversible stand-in for macOS secure storage.
const crypto = (available = true) => ({
  available: async () => available,
  encrypt: async (text: string) => Buffer.from([...Buffer.from(text)].reverse()),
  decrypt: async (bytes: Buffer) => ({ result: Buffer.from([...bytes].reverse()).toString(), shouldReEncrypt: false })
})
const key = 'AQ.Ab8RN6' + 'k'.repeat(40)

test('a remembered voice key is encrypted on disk and survives restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-voice-key-'))
  try {
    const store = new VoiceKeyStore(directory, crypto())
    assert.equal(await store.set(key, true), 'encrypted')
    assert.equal(readFileSync(join(directory, 'voice-gemini-key.enc')).includes(Buffer.from(key)), false, 'never stored in plain text')
    const reopened = new VoiceKeyStore(directory, crypto())
    await reopened.initialize()
    assert.equal(reopened.get(), key)
    assert.equal(reopened.status(), 'encrypted')
    reopened.remove()
    assert.equal(existsSync(join(directory, 'voice-gemini-key.enc')), false)
    assert.equal(reopened.get(), null)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a session key is never written and non-Gemini keys are refused', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'triage-voice-key-'))
  try {
    const store = new VoiceKeyStore(directory, crypto())
    assert.equal(await store.set(key, false), 'session')
    assert.equal(existsSync(join(directory, 'voice-gemini-key.enc')), false)
    await assert.rejects(store.set('sk-ant-api03-' + 'x'.repeat(30), true), { code: 'invalid_input' })
    assert.equal(store.get(), key, 'a refused key leaves the old one in place')
    await assert.rejects(new VoiceKeyStore(directory, crypto(false)).set(key, true), { code: 'key_storage' })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
