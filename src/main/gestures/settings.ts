import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_SHAKE_INSTRUCTION, type ShakeSettings } from '../../shared/shake-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { redact } from '../assistant/redaction.ts'

const schema = z.object({ enabled: z.boolean(), instruction: z.string().trim().min(1).max(4000), mode: z.enum(['explain', 'highlight', 'simplify']).optional() }).strict()

export class ShakePreferences {
  private value: ShakeSettings = { enabled: false, instruction: DEFAULT_SHAKE_INSTRUCTION }
  private file: string
  private sanitize: (text: string) => string
  constructor(directory: string, sanitize: (text: string) => string = redact) {
    this.sanitize = sanitize
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, 'shake-settings.json')
    if (existsSync(this.file)) {
      try {
        const value = schema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
        this.value = { ...value, instruction: sanitize(value.instruction) }
      } catch { this.value.warning = 'Shake settings could not be read. Shake to Help is off; save settings to recover.' }
    }
  }
  snapshot(): ShakeSettings { return { ...this.value } }
  save(input: unknown): ShakeSettings {
    const parsed = schema.safeParse(input)
    if (!parsed.success) throw new AppProblem('invalid_input', 'Use an instruction between 1 and 4,000 characters.')
    const value = { ...parsed.data, instruction: this.sanitize(parsed.data.instruction) }
    try {
      writeFileSync(this.file + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 })
      renameSync(this.file + '.tmp', this.file)
    } catch { throw new AppProblem('storage', 'Shake settings could not be saved. Check disk access and try again.') }
    this.value = value
    return this.snapshot()
  }
}
