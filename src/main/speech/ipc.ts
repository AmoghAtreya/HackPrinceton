import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { SPEECH_MAX_CHARS, speechChannels, type SynthesizedSpeech } from '../../shared/speech-contracts.ts'
import { AppProblem, resultOf } from '../assistant/errors.ts'
import type { PollyService } from './polly.ts'
import type { SpeechPreferences } from './settings.ts'
import type { SpeechSettings } from '../../shared/speech-contracts.ts'

/** Gemini key for voice transcription: where it comes from, and setting or removing the voice-only key. */
export interface GeminiVoiceKeyAccess {
  status(): Pick<SpeechSettings, 'geminiKeyAvailable' | 'geminiKeySource' | 'geminiVoiceKey'>
  set(key: unknown, remember: unknown): Promise<void>
  remove(): void
}

export function installSpeechIpc(
  ipcMain: IpcMain,
  polly: PollyService,
  preferences: SpeechPreferences,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  geminiKey?: GeminiVoiceKeyAccess
): () => void {
  const snapshot = (): SpeechSettings => ({ ...preferences.snapshot(), ...(geminiKey?.status() ?? { geminiKeyAvailable: false, geminiKeySource: null, geminiVoiceKey: 'none' }) })
  const handle = (channel: string, action: (input: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => resultOf(() => {
      if (!trusted(event)) throw new AppProblem('untrusted', 'This window cannot use voice replies.')
      return action(input)
    }))
  }
  handle(speechChannels.getSettings, () => snapshot())
  handle(speechChannels.saveSettings, (input) => { preferences.save(input); return snapshot() })
  handle(speechChannels.setGeminiKey, async (input) => {
    if (!geminiKey) throw new AppProblem('unavailable', 'Gemini voice keys are unavailable in this build.')
    const { key, remember } = (typeof input === 'object' && input !== null ? input : {}) as { key?: unknown; remember?: unknown }
    await geminiKey.set(key, remember)
    return snapshot()
  })
  handle(speechChannels.removeGeminiKey, () => { geminiKey?.remove(); return snapshot() })
  handle(speechChannels.synthesize, async (input): Promise<SynthesizedSpeech> => {
    if (typeof input !== 'string' || !input.trim() || input.length > SPEECH_MAX_CHARS)
      throw new AppProblem('invalid_input', 'That reply is too long to read aloud.')
    const { voice, rate } = preferences.snapshot()
    return { audio: await polly.synthesize(input, voice, rate), voice }
  })
  return () => {
    for (const channel of Object.values(speechChannels)) ipcMain.removeHandler(channel)
  }
}
