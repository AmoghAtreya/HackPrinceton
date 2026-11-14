import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { VoiceSettings } from '../../shared/voice-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'

export const voiceSettingsSchema = z.object({
  enabled: z.boolean(), microphoneId: z.string().min(1).max(256).nullable(),
  shortcut: z.string().regex(/^(?:(?:Control|Option|Shift|Command)\+){1,4}(?:Space|[A-Z0-9])$/)
    .refine((chord) => new Set(chord.split('+')).size === chord.split('+').length),
  spokenReplies: z.literal(false), allowScreenCapture: z.literal(false)
}).strict()
export const defaultVoiceSettings: VoiceSettings = {
  enabled: false, microphoneId: null, shortcut: 'Control+Option+Space',
  spokenReplies: false, allowScreenCapture: false
}
export class VoicePreferences {
  private value: VoiceSettings = { ...defaultVoiceSettings }
  readonly warning: string
  private file: string
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, 'voice-settings.json')
    this.warning = ''
    if (existsSync(this.file)) {
      try { this.value = voiceSettingsSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) }
      catch { this.warning = 'Voice settings could not be read. Voice is off; save settings to recover.' }
    }
  }
  snapshot(): VoiceSettings { return { ...this.value } }
  save(input: unknown): VoiceSettings {
    const parsed = voiceSettingsSchema.safeParse(input)
    if (!parsed.success) throw new AppProblem('invalid_input', 'Check the microphone and shortcut. Spoken replies and voice screen access are unavailable in this phase.')
    try {
      writeFileSync(this.file + '.tmp', JSON.stringify(parsed.data) + '\n', { mode: 0o600 })
      renameSync(this.file + '.tmp', this.file)
    } catch { throw new AppProblem('storage', 'Voice settings could not be saved. Check disk access and retry.') }
    this.value = parsed.data
    return this.snapshot()
  }
}
