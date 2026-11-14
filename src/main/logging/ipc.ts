import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { requestLogChannels } from '../../shared/request-log-contracts.ts'
import { AppProblem, resultOf } from '../assistant/errors.ts'
import type { LocalRequestLog } from './request-log.ts'

export function installRequestLogIpc(ipcMain: IpcMain, log: LocalRequestLog, trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  const handle = (channel: string, action: (input: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => resultOf(() => {
      if (!trusted(event)) throw new AppProblem('untrusted', 'This window cannot change sharing settings.')
      return action(input)
    }))
  }
  handle(requestLogChannels.getSettings, () => log.snapshot())
  handle(requestLogChannels.saveSettings, (input) => log.save(input))
  handle(requestLogChannels.clear, () => log.clear())
  return () => {
    for (const channel of Object.values(requestLogChannels)) ipcMain.removeHandler(channel)
  }
}
