import type { ShakePreferences } from '../gestures/settings'
import type { ScreenPreview } from '../../shared/screen-contracts.ts'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { assistantChannels } from '../../shared/assistant-contracts.ts'
import { AssistantCoordinator } from './coordinator.ts'
import { AppProblem, resultOf } from './errors.ts'
import { detailSchema, listSchema, validated } from './schemas.ts'

export function installAssistantIpc(
  assistant: AssistantCoordinator,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  screens: { capture(): Promise<ScreenPreview>; clear(): void },
  shake: ShakePreferences,
  resetShake: () => void
): () => void {
  const register = (channel: string, action: (input: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, input: unknown) => resultOf(() => {
      if (!trusted(event)) throw new AppProblem('untrusted', 'This window cannot access conversation settings.')
      return action(input)
    }))
  }
  register(assistantChannels.getShake, () => shake.snapshot())
  register(assistantChannels.saveShake, (input) => {
    const saved = shake.save(input)
    resetShake()
    return saved
  })
  register(assistantChannels.capture, () => {
    if (assistant.snapshot().active) throw new AppProblem('busy', 'Stop or finish the current reply before capturing.')
    assistant.clearHighlight()
    return screens.capture()
  })
  register(assistantChannels.discard, () => { assistant.clearHighlight(); screens.clear() })
  register(assistantChannels.dismissHighlight, () => assistant.clearHighlight())
  register(assistantChannels.getState, () => assistant.snapshot())
  register(assistantChannels.connect, (input) => assistant.connect(input))
  register(assistantChannels.removeKey, () => assistant.removeKey())
  register(assistantChannels.selectModel, (input) => assistant.selectModel(input))
  register(assistantChannels.setFastModel, (input) => assistant.setFastModel(input))
  register(assistantChannels.send, (input) => assistant.send(input))
  register(assistantChannels.closeBrowser, () => assistant.closeBrowser())
  register(assistantChannels.stop, (input) => assistant.stop(input))
  register(assistantChannels.list, (input) => assistant.history.list(validated(listSchema, input).before))
  register(assistantChannels.detail, (input) => {
    const { id, before, beforeEvent } = validated(detailSchema, input)
    return assistant.history.detail(id, before, beforeEvent)
  })
  register(assistantChannels.delete, (input) => assistant.deleteConversation(input))
  register(assistantChannels.clear, () => assistant.clearHistory())
  register(assistantChannels.analyze, (input) => assistant.analyzeScreen(input))
  register(assistantChannels.learning, () => assistant.learning())
  register(assistantChannels.rate, (input) => assistant.rateSimplification(input))
  register(assistantChannels.memory, () => assistant.memorySnapshot())
  register(assistantChannels.forget, (input) => assistant.forgetMemory(input))
  return () => {
    for (const channel of Object.values(assistantChannels)) ipcMain.removeHandler(channel)
  }
}
