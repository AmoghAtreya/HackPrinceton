import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretCrypto } from '../assistant/credentials.ts'
import { AppProblem } from '../assistant/errors.ts'
import { isGeminiKey } from '../assistant/gemini.ts'

export type VoiceKeyStorage = 'none' | 'session' | 'encrypted' | 'locked'

/**
 * A Gemini key used only for voice transcription, separate from the chatbot
 * key (which can stay Anthropic). Encrypted with macOS secure storage when
 * remembered; otherwise kept in memory until Triage quits.
 */
export class VoiceKeyStore {
  private readonly file: string
  private readonly crypto: SecretCrypto
  private key: string | null = null
  private storage: VoiceKeyStorage = 'none'

  constructor(directory: string, crypto: SecretCrypto) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, 'voice-gemini-key.enc')
    this.crypto = crypto
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.file)) return
    try {
      if (!await this.crypto.available()) throw new Error('unavailable')
      const decrypted = await this.crypto.decrypt(readFileSync(this.file))
      if (!isGeminiKey(decrypted.result)) throw new Error('invalid')
      if (decrypted.shouldReEncrypt) this.write(await this.crypto.encrypt(decrypted.result))
      this.key = decrypted.result
      this.storage = 'encrypted'
    } catch {
      this.storage = 'locked'
    }
  }

  get(): string | null { return this.key }

  status(): VoiceKeyStorage { return this.storage }

  async set(input: unknown, remember: unknown): Promise<VoiceKeyStorage> {
    const key = typeof input === 'string' ? input.trim() : ''
    if (!isGeminiKey(key) || key.length > 512)
      throw new AppProblem('invalid_input', 'That doesn’t look like a Gemini key. Gemini keys start with “AIza” or “AQ.”; create one at aistudio.google.com/apikey.')
    if (remember === true) {
      try {
        if (!await this.crypto.available()) throw new Error('unavailable')
        this.write(await this.crypto.encrypt(key))
      } catch {
        throw new AppProblem('key_storage', 'macOS secure storage is unavailable. Untick Remember on this Mac to use the key until Triage quits.')
      }
      this.storage = 'encrypted'
    } else {
      rmSync(this.file, { force: true })
      this.storage = 'session'
    }
    this.key = key
    return this.storage
  }

  remove(): VoiceKeyStorage {
    rmSync(this.file, { force: true })
    this.key = null
    this.storage = 'none'
    return this.storage
  }

  private write(bytes: Buffer): void {
    writeFileSync(this.file + '.tmp', bytes, { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
  }
}
