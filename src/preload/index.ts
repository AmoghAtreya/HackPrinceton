import { contextBridge, ipcRenderer } from 'electron'
import { voiceChannels, type SpeechStateMessage, type UserUtterance } from '../shared/voice-contracts'
import { speechChannels } from '../shared/speech-contracts'
import { requestLogChannels } from '../shared/request-log-contracts'
import { highlightChannels, type OverlayBridge, type HighlightState } from '../shared/highlight-contracts'
import { channels, type DesktopBridge, type DesktopState } from '../shared/contracts'
import { assistantChannels, type AssistantState } from '../shared/assistant-contracts'

const bridge: DesktopBridge = {
  getRequestLogSettings: () => ipcRenderer.invoke(requestLogChannels.getSettings),
  saveRequestLogSettings: (input) => ipcRenderer.invoke(requestLogChannels.saveSettings, input),
  clearRequestLog: () => ipcRenderer.invoke(requestLogChannels.clear),
  getSpeechSettings: () => ipcRenderer.invoke(speechChannels.getSettings),
  saveSpeechSettings: (input) => ipcRenderer.invoke(speechChannels.saveSettings, input),
  synthesizeSpeech: (text) => ipcRenderer.invoke(speechChannels.synthesize, text),
  startVoice: () => ipcRenderer.invoke(voiceChannels.start),
  sendVoiceAudio: (sessionId, chunk) => ipcRenderer.send(voiceChannels.audio, sessionId, chunk),
  finishVoice: (sessionId) => ipcRenderer.invoke(voiceChannels.finish, sessionId),
  cancelVoice: (sessionId) => ipcRenderer.invoke(voiceChannels.cancel, sessionId),
  listTranscripts: () => ipcRenderer.invoke(voiceChannels.list),
  onSpeechState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, message: SpeechStateMessage): void => listener(message)
    ipcRenderer.on(voiceChannels.state, receive)
    return () => { ipcRenderer.removeListener(voiceChannels.state, receive) }
  },
  onUtterance: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, utterance: UserUtterance): void => listener(utterance)
    ipcRenderer.on(voiceChannels.utterance, receive)
    return () => { ipcRenderer.removeListener(voiceChannels.utterance, receive) }
  },
  getShakeSettings: () => ipcRenderer.invoke(assistantChannels.getShake),
  saveShakeSettings: (input) => ipcRenderer.invoke(assistantChannels.saveShake, input),
  captureScreen: () => ipcRenderer.invoke(assistantChannels.capture),
  discardScreen: () => ipcRenderer.invoke(assistantChannels.discard),
  dismissHighlight: () => ipcRenderer.invoke(assistantChannels.dismissHighlight),
  getAssistantState: () => ipcRenderer.invoke(assistantChannels.getState),
  onAssistantState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: AssistantState): void => listener(state)
    ipcRenderer.on(assistantChannels.state, receive)
    return () => { ipcRenderer.removeListener(assistantChannels.state, receive) }
  },
  connectKey: (input) => ipcRenderer.invoke(assistantChannels.connect, input),
  removeKey: () => ipcRenderer.invoke(assistantChannels.removeKey),
  selectModel: (model) => ipcRenderer.invoke(assistantChannels.selectModel, model),
  sendMessage: (input) => ipcRenderer.invoke(assistantChannels.send, input),
  closeBrowser: () => ipcRenderer.invoke(assistantChannels.closeBrowser),
  stopRequest: (id) => ipcRenderer.invoke(assistantChannels.stop, id),
  listConversations: (input) => ipcRenderer.invoke(assistantChannels.list, input),
  getConversation: (input) => ipcRenderer.invoke(assistantChannels.detail, input),
  analyzeScreen: (input) => ipcRenderer.invoke(assistantChannels.analyze, input),
  deleteConversation: (id) => ipcRenderer.invoke(assistantChannels.delete, id),
  clearHistory: () => ipcRenderer.invoke(assistantChannels.clear),
  getLearning: () => ipcRenderer.invoke(assistantChannels.learning),
  rateSimplification: (input) => ipcRenderer.invoke(assistantChannels.rate, input),
  getMemory: () => ipcRenderer.invoke(assistantChannels.memory),
  forgetMemory: (id) => ipcRenderer.invoke(assistantChannels.forget, id),
  getState: () => ipcRenderer.invoke(channels.getState),
  onState: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, state: DesktopState): void => listener(state)
    ipcRenderer.on(channels.state, receive)
    return () => { ipcRenderer.removeListener(channels.state, receive) }
  },
  toggleChat: () => ipcRenderer.send(channels.toggleChat),
  closeChat: () => ipcRenderer.send(channels.closeChat),
  hide: () => ipcRenderer.send(channels.hide),
  quit: () => ipcRenderer.send(channels.quit),
  openMenu: () => ipcRenderer.send(channels.menu),
  beginDrag: (point) => ipcRenderer.send(channels.dragStart, point),
  endDrag: (allowClick = true, point) => ipcRenderer.send(channels.dragEnd, allowClick, point),
  setPointerInteractive: (interactive) => ipcRenderer.send(channels.pointer, interactive)
}

if (process.argv.includes('--triage-overlay')) {
  const overlay: OverlayBridge = {
    getHighlight: () => ipcRenderer.invoke(highlightChannels.get),
    onHighlight: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, state: HighlightState | null): void => listener(state)
      ipcRenderer.on(highlightChannels.state, receive)
      return () => { ipcRenderer.removeListener(highlightChannels.state, receive) }
    },
    highlightReady: (id) => ipcRenderer.send(highlightChannels.ready, id)
  }
  contextBridge.exposeInMainWorld('triageOverlay', overlay)
} else contextBridge.exposeInMainWorld('triage', bridge)
