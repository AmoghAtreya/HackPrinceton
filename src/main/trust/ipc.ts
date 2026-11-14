import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { trustChannels } from '../../shared/trust-contracts'
import { AppProblem, resultOf } from '../assistant/errors'
import type { TrustService } from './service'

/** Every handler here is reached only from Triage's own chat window, by the person at the keyboard. */
export function installTrustIpc(trust: TrustService, trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  const register = (channel: string, action: (input: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => resultOf(() => {
      if (!trusted(event)) throw new AppProblem('untrusted', 'This window cannot change the list of people and organizations.')
      return action(input)
    }))
  }
  register(trustChannels.graph, () => trust.graph())
  register(trustChannels.addEntity, (input) => trust.addEntity(input))
  register(trustChannels.updateEntity, (input) => trust.updateEntity(input))
  register(trustChannels.deleteEntity, (input) => trust.deleteEntity(input))
  register(trustChannels.addChannel, (input) => trust.addChannel(input))
  register(trustChannels.deleteChannel, (input) => trust.deleteChannel(input))
  register(trustChannels.deleteDecision, (input) => trust.deleteDecision(input))
  register(trustChannels.getState, () => trust.state())
  register(trustChannels.decide, (input) => trust.decide(input))
  register(trustChannels.dismiss, () => trust.dismiss())
  return () => {
    for (const channel of Object.values(trustChannels)) if (channel !== trustChannels.state) ipcMain.removeHandler(channel)
  }
}
