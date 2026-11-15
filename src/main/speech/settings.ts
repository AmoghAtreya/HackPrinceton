import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_SPEECH_SETTINGS, speechRates, speechVoices, type SpeechSettings } from '../../shared/speech-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'

const schema = z.object({
  readAloud: z.enum(['voice', 'always', 'off']),
  rate: z.union(speechRates.map((rate) => z.literal(rate)) as [z.ZodLiteral<80>, z.ZodLiteral<90>, z.ZodLiteral<100>, z.ZodLiteral<115>]),
  voice: z.enum(speechVoices),
  geminiTranscription: z.boolean().optional()
}).strict()

/** Spoken-reply settings, saved as speech-settings.json in Triage's user-data folder. */
export class SpeechPreferences {
  private value: SpeechSettings = { ...DEFAULT_SPEECH_SETTINGS }
  private file: string

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = join(directory, 'speech-settings.json')
    if (existsSync(this.file)) {
      try { this.value = { ...DEFAULT_SPEECH_SETTINGS, ...schema.parse(JSON.parse(readFileSync(this.file, 'utf8'))) } }
      catch { this.value.warning = 'Voice reply settings could not be read, so the defaults are in use. Save settings to fix this.' }
    }
  }

  snapshot(): SpeechSettings { return { ...this.value } }

  save(input: unknown): SpeechSettings {
    const parsed = schema.safeParse(input)
    if (!parsed.success) throw new AppProblem('invalid_input', 'Choose when to read replies, a speed and a voice.')
    // An older window may not send the Gemini choice; keep the saved one.
    const value: SpeechSettings = { ...parsed.data, geminiTranscription: parsed.data.geminiTranscription ?? this.value.geminiTranscription }
    try {
      writeFileSync(this.file + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 })
      renameSync(this.file + '.tmp', this.file)
    } catch { throw new AppProblem('storage', 'Voice reply settings could not be saved. Check disk access and try again.') }
    this.value = value
    return this.snapshot()
  }
}
