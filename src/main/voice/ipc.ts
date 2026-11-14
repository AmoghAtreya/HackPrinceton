import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { voiceChannels } from '../../shared/voice-contracts.ts'
import { AppProblem, resultOf } from '../assistant/errors.ts'
import type { VoiceController } from './controller.ts'

function sessionId(input: unknown): string {
  if (typeof input !== 'string' || input.length > 64) throw new AppProblem('invalid_input', 'Unknown recording.')
  return input
}

function pcm(input: unknown): Uint8Array | null {
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return null
}

export function installVoiceIpc(
  ipcMain: IpcMain,
  voice: VoiceController,
  trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean
): () => void {
  const handle = (channel: string, action: (input: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => resultOf(() => {
      if (!trusted(event)) throw new AppProblem('untrusted', 'This window cannot use voice input.')
      return action(input)
    }))
  }
  handle(voiceChannels.start, () => voice.start())
  handle(voiceChannels.finish, (input) => voice.finish(sessionId(input)))
  handle(voiceChannels.cancel, (input) => voice.cancel(sessionId(input)))
  handle(voiceChannels.list, () => voice.recent())

  const audio = (event: IpcMainEvent, id: unknown, chunk: unknown): void => {
    if (!trusted(event) || typeof id !== 'string') return
    const bytes = pcm(chunk)
    if (bytes) voice.pushAudio(id, bytes)
  }
  ipcMain.on(voiceChannels.audio, audio)

  return () => {
    for (const channel of [voiceChannels.start, voiceChannels.finish, voiceChannels.cancel, voiceChannels.list]) ipcMain.removeHandler(channel)
    ipcMain.removeListener(voiceChannels.audio, audio)
  }
}
