import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { skillChannels } from '../../shared/skill-contracts'
import { AppProblem, resultOf } from '../assistant/errors'
import type { SkillTutor } from './tutor'

// Triage is single-user on this Mac, as in the assistant coordinator.
const LOCAL_USER = 'local-user'

/** Only the standings view and the practice mark cross this boundary; the estimates themselves do not. */
export function installSkillsIpc(tutor: SkillTutor, trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  const register = (channel: string, action: (input: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => resultOf(() => {
      if (!trusted(event)) throw new AppProblem('untrusted', 'This window cannot see what Triage has learned.')
      return action(input)
    }))
  }
  register(skillChannels.view, () => tutor.view(LOCAL_USER))
  register(skillChannels.practice, (input) => tutor.setPractice(LOCAL_USER, input))
  return () => { for (const channel of Object.values(skillChannels)) ipcMain.removeHandler(channel) }
}
