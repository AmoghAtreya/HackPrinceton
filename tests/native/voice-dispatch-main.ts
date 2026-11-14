// Isolated fixture entry point: production renderer/preload/IPC/session/coordinator,
// synthetic speech and model only. Never loaded by the production app.
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { AssistantCoordinator } from '../../src/main/assistant/coordinator.ts'
import { Credentials } from '../../src/main/assistant/credentials.ts'
import { HistoryStore } from '../../src/main/assistant/history.ts'
import { installAssistantIpc } from '../../src/main/assistant/ipc.ts'
import { ShakePreferences } from '../../src/main/gestures/settings.ts'
import { VoiceSession } from '../../src/main/voice/session.ts'
import { VoicePreferences } from '../../src/main/voice/settings.ts'
import { installVoiceIpc } from '../../src/main/voice/ipc.ts'
import { assistantChannels } from '../../src/shared/assistant-contracts.ts'
import { voiceChannels } from '../../src/shared/voice-contracts.ts'
import { channels } from '../../src/shared/contracts.ts'
import type { SpeechEvent } from '../../src/main/voice/adapter.ts'
import type { ScreenService } from '../../src/main/screen/service.ts'

const directory = process.env.TRIAGE_DATA_DIR!
app.setPath('userData', directory)
void app.whenReady().then(async () => {
  const root = process.cwd()
  const window = new BrowserWindow({ width: 392, height: 540, webPreferences: {
    preload: join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } })
  const publish = (channel: string, state: unknown) => { if (!window.isDestroyed()) window.webContents.send(channel, state) }
  const history = new HistoryStore(join(directory, 'history.sqlite'))
  const credentials = new Credentials(directory, { available: async () => false,
    encrypt: async () => { throw Error() }, decrypt: async () => { throw Error() } })
  await credentials.connect('fixture-only-not-a-real-provider-key', false, [{ id: 'fixture', label: 'Fixture' }])
  const contexts: unknown[] = []
  let late: (() => void) | undefined
  const assistant = new AssistantCoordinator({ history, credentials,
    changed: (state) => publish(assistantChannels.state, state), gateway: {
      models: async () => [], reply: async (_key, _model, turns) => {
        contexts.push(turns)
        if (turns.at(-1)?.content === 'Hold fixture task') return new Promise<string>((resolve) => { late = () => resolve('Late result must be suppressed') })
        return contexts.length === 1 ? 'Which date?' : 'Fixture answer received'
      }
    } })
  const availability = { microphone: 'authorized' as const, speech: 'authorized' as const,
    available: true, onDevice: true, devices: [{ id: 'fixture', label: 'Synthetic microphone' }] }
  let finalText = 'Fixture question'
  let emit: (event: SpeechEvent) => void
  let sequence = 0
  const voice = new VoiceSession(new VoicePreferences(directory), (receive) => {
    emit = receive
    function event(type: string, sessionId: string, text?: string) {
      receive({ v: 1, generation: 'fixture', seq: ++sequence, type, sessionId, ...(text ? { text } : {}) } as SpeechEvent)
    }
    return { initialize: async () => availability, requestPermissions: async () => availability,
      start: (id) => { queueMicrotask(() => { event('started', id); event('partial', id, 'Synthetic provisional text') }) },
      finish: (id) => { queueMicrotask(() => { event('final', id, finalText); event('final', id, 'Duplicate final') }) },
      cancel: () => {}, dispose: () => {} }
  }, (state) => publish(voiceChannels.state, state), undefined, {
    reserve: (id) => assistant.reserveVoice(id), release: (id) => assistant.releaseVoice(id),
    submit: (id, text, conversationId) => assistant.sendVoice(id, text, conversationId),
    stop: () => assistant.stopActive(), conversation: (id) => history.summary(id)
  })
  voice.setChatOpen(true)
  const trusted = (event: Electron.IpcMainInvokeEvent) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  installVoiceIpc(ipcMain, voice, trusted)
  const screens = { capture: () => { throw Error('Unexpected capture') }, clear: () => {} } as unknown as ScreenService
  installAssistantIpc(assistant, trusted, screens, new ShakePreferences(directory), () => {})
  ipcMain.handle(channels.getState, () => ({ visible: true, chatOpen: true, mood: 'idle', shortcutAvailable: false }))
  window.on('hide', () => voice.setChatOpen(false))
  Object.assign(globalThis, { voiceFixture: {
    final: (text: string) => { finalText = text }, contexts: () => contexts,
    late: () => late?.(), state: () => voice.snapshot(),
    stale: (id: string) => emit({ type: 'final', sessionId: id, text: 'Stale final' } as SpeechEvent)
  } })
  app.on('before-quit', () => { void voice.dispose(); assistant.dispose() })
  await window.loadFile(join(root, 'out/renderer/index.html'), { query: { view: 'chat' } })
})
