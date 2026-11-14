import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { Credentials, type SecretCrypto } from '../src/main/assistant/credentials.ts'

const FAKE_KEY = 'unit-test-only-key-not-a-real-provider-credential'
const MODELS = [{ id: 'claude-sonnet-test', label: 'Test Sonnet' }, { id: 'claude-haiku-test', label: 'Test Haiku' }]

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'triage-credentials-'))
  const secret = randomBytes(32)
  const crypto: SecretCrypto = {
    available: async () => true,
    encrypt: async (text) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', secret, iv)
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decrypt: async (bytes) => {
      const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false }
    }
  }
  return { directory, crypto, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('session-only keys never persist or appear in public settings', async () => {
  const f = fixture()
  try {
    const vault = new Credentials(f.directory, { ...f.crypto, available: async () => { throw new Error('must not touch secure storage') } })
    await vault.initialize()
    await vault.connect(FAKE_KEY, false, MODELS)
    assert.equal(vault.getKey(), FAKE_KEY)
    assert.equal(vault.snapshot().keyStorage, 'session')
    assert.ok(!JSON.stringify(vault.snapshot()).includes(FAKE_KEY))
    assert.equal(existsSync(join(f.directory, 'credentials.enc')), false)
    assert.ok(!readFileSync(join(f.directory, 'model-settings.json'), 'utf8').includes(FAKE_KEY))
    const reopened = new Credentials(f.directory, f.crypto)
    await reopened.initialize()
    assert.equal(reopened.snapshot().configured, false)
    assert.equal(reopened.snapshot().model, 'claude-sonnet-test')
  } finally { f.cleanup() }
})

test('encrypted keys restore and can be removed without exposing plaintext', async () => {
  const f = fixture()
  try {
    const vault = new Credentials(f.directory, f.crypto)
    await vault.initialize()
    await vault.connect(FAKE_KEY, true, MODELS)
    assert.ok(!readFileSync(join(f.directory, 'credentials.enc')).includes(Buffer.from(FAKE_KEY)))
    vault.select('claude-haiku-test')
    const reopened = new Credentials(f.directory, f.crypto)
    await reopened.initialize()
    assert.equal(reopened.getKey(), FAKE_KEY)
    assert.equal(reopened.snapshot().model, 'claude-haiku-test')
    assert.throws(() => reopened.select('unlisted-model'))
    reopened.remove()
    assert.equal(existsSync(join(f.directory, 'credentials.enc')), false)
    assert.equal(reopened.snapshot().configured, false)
    assert.throws(() => reopened.getKey())
  } finally { f.cleanup() }
})

test('unavailable encryption fails closed but session mode remains usable', async () => {
  const f = fixture()
  try {
    const vault = new Credentials(f.directory, { ...f.crypto, available: async () => false })
    await assert.rejects(vault.connect(FAKE_KEY, true, MODELS), /session-only/)
    assert.equal(vault.snapshot().configured, false)
    assert.equal(existsSync(join(f.directory, 'credentials.enc')), false)
    await vault.connect(FAKE_KEY, false, MODELS)
    assert.equal(vault.snapshot().configured, true)
  } finally { f.cleanup() }
})

test('locked keys warn without leaking decryption errors or silently overwriting them', async () => {
  const f = fixture()
  try {
    const saved = new Credentials(f.directory, f.crypto)
    await saved.connect(FAKE_KEY, true, MODELS)
    const encrypted = readFileSync(join(f.directory, 'credentials.enc'))
    const locked = new Credentials(f.directory, { ...f.crypto, decrypt: async () => { throw new Error(FAKE_KEY) } })
    await locked.initialize()
    assert.equal(locked.snapshot().keyStorage, 'locked')
    assert.ok(!JSON.stringify(locked.snapshot()).includes(FAKE_KEY))
    assert.deepEqual(readFileSync(join(f.directory, 'credentials.enc')), encrypted)
    await locked.connect(FAKE_KEY, false, MODELS)
    assert.equal(existsSync(join(f.directory, 'credentials.enc')), false)
  } finally { f.cleanup() }
})
