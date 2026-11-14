import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { voiceChannels, type VoiceSettings } from '../../shared/voice-contracts.ts'
import { AppProblem, resultOf } from '../assistant/errors.ts'
import { validated } from '../assistant/schemas.ts'
import { voiceSettingsSchema } from './settings.ts'
import type { VoiceSession } from './session.ts'

export function installVoiceIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, session: VoiceSession,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  operations: { save(input: VoiceSettings): unknown; setup(): unknown } = session,
  statusSurface: (event: IpcMainInvokeEvent) => boolean = () => false): () => void {
  const installed: string[] = []
  function register<T>(channel: string, schema: z.ZodType<T>, action: (input: T) => unknown): void {
    ipc.handle(channel, (event, input: unknown, ...extra: unknown[]) => resultOf(() => {
      if (!trusted(event) && !(statusSurface(event) && [voiceChannels.get, voiceChannels.cancel, voiceChannels.stop].includes(channel as typeof voiceChannels.get))) throw new AppProblem('untrusted', 'This window cannot access voice.')
      if (extra.length) throw new AppProblem('invalid_input', 'Unexpected voice arguments.')
      return action(validated(schema, input))
    }))
    installed.push(channel)
  }
  register(voiceChannels.stop, z.undefined(), () => session.stop())
  register(voiceChannels.context, z.object({
    view: z.enum(['chat', 'history', 'settings']), conversationId: z.string().uuid().nullable(),
    explicitSelection: z.boolean().optional()
  }).strict(), (input) => session.setContext(input))
  register(voiceChannels.get, z.undefined(), () => session.snapshot())
  register(voiceChannels.save, voiceSettingsSchema, (input) => operations.save(input))
  register(voiceChannels.setup, z.undefined(), () => operations.setup())
  register(voiceChannels.start, z.undefined(), () => session.start())
  register(voiceChannels.finish, z.string().uuid(), (id) => session.finish(id))
  register(voiceChannels.cancel, z.string().uuid(), (id) => session.cancel(id))
  return () => { installed.forEach((channel) => ipc.removeHandler(channel)) }
}
