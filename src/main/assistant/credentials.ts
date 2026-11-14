import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ModelChoice, PublicConfig } from '../../shared/assistant-contracts.ts'
import { AppProblem } from './errors.ts'
import { modelSchema } from './schemas.ts'

export interface SecretCrypto {
  available(): Promise<boolean>
  encrypt(text: string): Promise<Buffer>
  decrypt(bytes: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

const preferencesSchema = z.object({
  model: modelSchema,
  models: z.array(z.object({ id: modelSchema, label: z.string().max(200) })).max(200)
})

export class Credentials {
  private directory: string
  private crypto: SecretCrypto
  private key: string | null = null
  private storage: PublicConfig['keyStorage'] = 'none'
  private model = ''
  private models: ModelChoice[] = []
  private warning?: string

  constructor(directory: string, crypto: SecretCrypto) {
    this.directory = directory
    this.crypto = crypto
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  private atomicWrite(name: string, bytes: string | Buffer): void {
    writeFileSync(join(this.directory, name + '.tmp'), bytes, { mode: 0o600 })
    renameSync(join(this.directory, name + '.tmp'), join(this.directory, name))
  }

  async initialize(): Promise<void> {
    try {
      const data = preferencesSchema.parse(JSON.parse(readFileSync(join(this.directory, 'model-settings.json'), 'utf8')))
      this.model = data.model
      this.models = data.models
    } catch { /* Absent or invalid non-secret preferences can be reset in settings. */ }
    const file = join(this.directory, 'credentials.enc')
    if (!existsSync(file)) return
    try {
      if (!await this.crypto.available()) throw new Error('unavailable')
      const decrypted = await this.crypto.decrypt(readFileSync(file))
      if (decrypted.result.length < 20 || decrypted.result.length > 512) throw new Error('invalid')
      if (decrypted.shouldReEncrypt) this.atomicWrite('credentials.enc', await this.crypto.encrypt(decrypted.result))
      this.key = decrypted.result
      this.storage = 'encrypted'
    } catch {
      this.storage = 'locked'
      this.warning = 'Your saved key could not be unlocked. Reconnect, use a session-only key, or remove it.'
    }
  }

  getKey(): string {
    if (!this.key) throw new AppProblem('missing_key', 'Connect your Anthropic API key in Settings first.')
    return this.key
  }

  snapshot(): PublicConfig {
    return {
      configured: this.key !== null, model: this.model,
      models: this.models.map((model) => ({ ...model })),
      keyStorage: this.storage, ...(this.warning ? { warning: this.warning } : {})
    }
  }

  async connect(key: string, remember: boolean, models: ModelChoice[]): Promise<PublicConfig> {
    let encrypted: Buffer | undefined
    if (remember) {
      try {
        if (!await this.crypto.available()) throw new Error('unavailable')
        encrypted = await this.crypto.encrypt(key)
      } catch {
        throw new AppProblem('key_storage', 'macOS secure storage is unavailable. Uncheck Remember on this Mac to use a session-only key.')
      }
    }
    const preferred = models.find((item) => item.id === this.model) ??
      models.find((item) => /sonnet/i.test(item.id)) ?? models.find((item) => /haiku/i.test(item.id)) ?? models[0]
    if (!preferred) throw new AppProblem('no_models', 'No usable Claude models were returned for this key.')
    try {
      this.atomicWrite('model-settings.json', JSON.stringify({ model: preferred.id, models }))
      if (encrypted) this.atomicWrite('credentials.enc', encrypted)
      else rmSync(join(this.directory, 'credentials.enc'), { force: true })
    } catch {
      throw new AppProblem('key_storage', 'Key settings could not be saved. Check disk access and try again.')
    }
    this.key = key
    this.storage = remember ? 'encrypted' : 'session'
    this.models = models.map((model) => ({ ...model }))
    this.model = preferred.id
    this.warning = undefined
    return this.snapshot()
  }

  select(model: string): PublicConfig {
    if (!this.models.some((item) => item.id === model)) throw new AppProblem('invalid_model', 'Choose a model returned for your connected key.')
    try { this.atomicWrite('model-settings.json', JSON.stringify({ model, models: this.models })) }
    catch { throw new AppProblem('storage', 'The model setting could not be saved.') }
    this.model = model
    return this.snapshot()
  }

  remove(): PublicConfig {
    try { rmSync(join(this.directory, 'credentials.enc'), { force: true }) }
    catch { throw new AppProblem('key_storage', 'The saved key could not be removed. Check disk access and try again.') }
    this.key = null
    this.storage = 'none'
    this.warning = undefined
    return this.snapshot()
  }

  dispose(): void { this.key = null }
}
