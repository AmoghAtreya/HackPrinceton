import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { SPEECH_MAX_CHARS, speechChannels, type SynthesizedSpeech } from '../../shared/speech-contracts.ts'
import { AppProblem, resultOf } from '../assistant/errors.ts'
import type { PollyService } from './polly.ts'
import type { SpeechPreferences } from './settings.ts'

export function installSpeechIpc(
  ipcMain: IpcMain,
  polly: PollyService,
  preferences: SpeechPreferences,
  trusted: (event: IpcMainInvokeEvent) => boolean
): () => void {
  const handle = (channel: string, action: (input: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => resultOf(() => {
      if (!trusted(event)) throw new AppProblem('untrusted', 'This window cannot use voice replies.')
      return action(input)
    }))
  }
  handle(speechChannels.getSettings, () => preferences.snapshot())
  handle(speechChannels.saveSettings, (input) => preferences.save(input))
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
