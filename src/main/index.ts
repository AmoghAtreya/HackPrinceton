import { VoiceShortcut } from './voice/shortcut'
import { VoiceSession } from './voice/session'
import { VoicePreferences } from './voice/settings'
import { NativeSpeechAdapter } from './voice/native-adapter'
import { installVoiceIpc } from './voice/ipc'
import { voiceChannels } from '../shared/voice-contracts'
import { BrowserSupervisor } from './browser/supervisor'
import { app, utilityProcess, dialog, globalShortcut, ipcMain, Menu, Tray, safeStorage, screen, powerMonitor, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { channels, type DesktopPoint } from '../shared/contracts'
import { createTrayIcon } from './tray-icon'
import { DesktopWindows } from './windows'
import { assistantChannels } from '../shared/assistant-contracts'
import { AssistantCoordinator } from './assistant/coordinator'
import { Credentials } from './assistant/credentials'
import { HistoryStore } from './assistant/history'
import { ClaudeGateway } from './assistant/model'
import { installAssistantIpc } from './assistant/ipc'
import { ScreenService } from './screen/service'
import { electronCapture } from './screen/electron-capture'
import { HighlightController } from './screen/highlight'
import { OverlayWindow } from './screen/overlay-window'
import { observeTargetClick } from './screen/target-click'
import { ShakePreferences } from './gestures/settings'
import { ShakeMonitor } from './gestures/monitor'
import { redact } from './assistant/redaction'
import { AppProblem } from './assistant/errors'
import { DEFAULT_BROWSER_CHANNEL, browserChannelFrom, type BrowserChannel } from '../shared/browser-config'

// A typo in TRIAGE_BROWSER_CHANNEL should not stop the app from launching.
function configuredBrowserChannel(): BrowserChannel {
  try { return browserChannelFrom(process.env) }
  catch (error) { console.warn(String(error)); return DEFAULT_BROWSER_CHANNEL }
}

app.setName('Triage')
// Allows authorized acceptance testing without touching the user's normal history.
if (process.env.TRIAGE_DATA_DIR) {
  const directory = resolve(process.env.TRIAGE_DATA_DIR)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  app.setPath('userData', directory)
}

let desktop: DesktopWindows | undefined
let tray: Tray | undefined
let quitting = false
let screens: ScreenService | undefined
let highlights: HighlightController | undefined
let overlay: OverlayWindow | undefined
let assistant: AssistantCoordinator | undefined
let browser: BrowserSupervisor | undefined
let shutdownReady = false
let removeAssistantIpc: (() => void) | undefined
let shakeMonitor: ShakeMonitor | undefined
let removeShakeListeners: (() => void) | undefined
let presentedGesture: string | undefined
let voiceShortcut: VoiceShortcut | undefined
let voice: VoiceSession | undefined
let removeVoiceIpc: (() => void) | undefined

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!desktop || !desktop.owns(event.sender) || event.senderFrame !== event.sender.mainFrame) return false
  try {
    const url = new URL(event.senderFrame.url)
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) {
      const expected = new URL(devUrl)
      return url.origin === expected.origin && url.pathname === expected.pathname
    }
    return url.protocol === 'file:' && fileURLToPath(url) === join(__dirname, '../renderer/index.html')
  } catch {
    return false
  }
}

function buildControls(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: 'Show Triage', click: () => desktop?.show() },
    { label: 'Open chat', click: () => desktop?.openChat() },
    { label: 'Hide Triage', click: () => desktop?.hide() },
    { label: 'Stop current task', click: () => assistant?.stopActive() },
    { type: 'separator' },
    { label: 'Quit Triage', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
  ])
}

function isPoint(value: unknown): value is DesktopPoint {
  if (typeof value !== 'object' || value === null || !('x' in value) || !('y' in value)) return false
  return typeof value.x === 'number' && Number.isFinite(value.x) && Math.abs(value.x) < 10000000 &&
    typeof value.y === 'number' && Number.isFinite(value.y) && Math.abs(value.y) < 10000000
}

function installIpc(): void {
  ipcMain.handle(channels.getState, (event) => {
    if (!trusted(event)) throw new Error('Untrusted desktop request.')
    return desktop!.getState()
  })

  const actions: Array<[string, () => void]> = [
    [channels.toggleChat, () => desktop?.toggleChat()],
    [channels.closeChat, () => desktop?.closeChat()],
    [channels.hide, () => desktop?.hide()],
    [channels.quit, () => app.quit()],
    [channels.menu, () => buildControls().popup()]
  ]
  for (const [channel, action] of actions) {
    ipcMain.on(channel, (event) => {
      if (!trusted(event)) return
      action()
    })
  }
  ipcMain.on(channels.dragStart, (event, point: unknown) => {
    if (trusted(event) && event.sender === desktop?.companion.webContents && isPoint(point)) desktop?.beginDrag(point)
  })
  ipcMain.on(channels.dragEnd, (event, allowClick: unknown, point: unknown) => {
    if (trusted(event) && event.sender === desktop?.companion.webContents && typeof allowClick === 'boolean' &&
        (point === undefined || isPoint(point))) {
      desktop?.finishDrag(allowClick, point)
    }
  })
  ipcMain.on(channels.pointer, (event, interactive: unknown) => {
    if (trusted(event) && event.sender === desktop?.companion.webContents && typeof interactive === 'boolean') {
      desktop?.setPointerInteractive(interactive)
    }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => desktop?.openChat())
  app.on('activate', () => {
    // Native activation also occurs when interacting with the non-focusable mascot.
    // Opening chat on every activation interrupts a drag before it can begin.
    if (!quitting && desktop && !desktop.isCapturing && !desktop.getState().visible) desktop.openChat()
  })
  app.on('window-all-closed', () => { if (!quitting) app.quit() })
  app.on('before-quit', (event) => {
    if (shutdownReady) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    // Reject input and stop native timers immediately, before waiting for Chromium.
    // Each cleanup runs even when another resource has already failed.
    const voiceClosed = Promise.all([voiceShortcut?.dispose(), voice?.dispose()])
    const cleanup = [
      () => removeVoiceIpc?.(),
      () => globalShortcut.unregisterAll(), () => shakeMonitor?.dispose(),
      () => removeShakeListeners?.(), () => removeAssistantIpc?.(),
      () => assistant?.dispose(), () => screens?.dispose(),
      () => highlights?.dispose(), () => overlay?.dispose(),
      () => desktop?.dispose(), () => tray?.destroy(),
      () => {
        ipcMain.removeHandler(channels.getState)
        for (const channel of Object.values(channels)) ipcMain.removeAllListeners(channel)
      }
    ]
    for (const close of cleanup) {
      try { close() } catch { console.warn('A Triage resource could not finish closing.') }
    }
    void Promise.resolve(voiceClosed).then(() => browser?.close()).catch(() => {
      console.warn('Triage browser shutdown failed.')
    }).finally(() => { shutdownReady = true; app.quit() })
  })

  app.whenReady().then(async () => {
    const directory = app.getPath('userData')
    const credentials = new Credentials(directory, {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptStringAsync(text),
      decrypt: (bytes) => safeStorage.decryptStringAsync(bytes)
    })
    await credentials.initialize()
    desktop = new DesktopWindows(directory)
    overlay = new OverlayWindow(() => {
      const window = desktop!.chat.isVisible() ? desktop!.chat : desktop!.companion
      if (window.isDestroyed() || !window.isVisible()) return undefined
      const { x, y } = window.getContentBounds()
      // The chat shell has a 10 DIP margin and a rounded top-left corner.
      return { x: x + 16, y: y + 16 }
    })
    await overlay.initialize()
    highlights = new HighlightController({
      display: (id) => overlay!.display(id), draw: (state) => overlay!.draw(state), hide: () => overlay!.hide(),
      blocked: (target) => desktop!.coversTarget(target), observeClick: observeTargetClick
    })
    const clearMovedMarker = () => { if (highlights?.snapshot()) highlights.clear() }
    desktop.companion.on('move', clearMovedMarker)
    desktop.chat.on('move', clearMovedMarker)
    for (const window of [desktop.chat, desktop.companion]) {
      window.on('show', () => overlay?.refreshArrow())
      window.on('hide', () => overlay?.refreshArrow())
    }
    screens = new ScreenService(electronCapture(desktop))
    browser = new BrowserSupervisor(() => utilityProcess.fork(join(__dirname, 'browser-worker.js'), [], {
      serviceName: 'Triage flight search', stdio: 'ignore',
      env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []))
    }), join(directory, 'browser-profile'), () => highlights?.clear(), configuredBrowserChannel())
    assistant = new AssistantCoordinator({
      history: new HistoryStore(join(directory, 'history.sqlite')),
      credentials, gateway: new ClaudeGateway(), screens, highlights, browser,
      changed: (state) => {
        if (!desktop || quitting) return
        desktop.setThinking(Boolean(state.active))
        if (!desktop.chat.isDestroyed()) desktop.chat.webContents.send(assistantChannels.state, state)
        if (state.gestureRequest && presentedGesture !== state.gestureRequest.taskId &&
            state.active?.stage !== 'capturing' && !desktop.isCapturing) {
          presentedGesture = state.gestureRequest.taskId
          desktop.openChat()
        }
      }
    })
    const shake = new ShakePreferences(directory, (text) => {
      let key = ''
      try { key = credentials.getKey() } catch { /* Session may be disconnected. */ }
      return redact(text, [key])
    })
    shakeMonitor = new ShakeMonitor({
      enabled: () => shake.snapshot().enabled,
      suppressed: () => Boolean(desktop?.isDragging || desktop?.isCapturing),
      sample: () => {
        const point = screen.getCursorScreenPoint()
        return { ...point, at: Date.now(), displayId: String(screen.getDisplayNearestPoint(point).id) }
      },
      trigger: (trigger) => {
        if (!assistant || !screens || quitting) return
        try {
          assistant.shake(trigger, shake.snapshot().instruction,
            () => screens!.capture({ cursor: trigger.point, focusAfterCapture: false }), shake.snapshot().mode)
        } catch { /* The coordinator publishes a blocking notice if history cannot be saved. */ }
      }
    })
    installIpc()
    removeAssistantIpc = installAssistantIpc(assistant, (event) => trusted(event) && event.sender === desktop?.chat.webContents,
      screens, shake, () => shakeMonitor?.reset())
    // Local ad-hoc builds retain Electron's executable name, which can make
    // app.isPackaged false. Prefer the actual bundled helper before dev resources.
    const bundledVoice = join(process.resourcesPath, '../Helpers/TriageVoiceHelper.app')
    const voiceHelper = existsSync(bundledVoice) ? bundledVoice :
      app.isPackaged ? bundledVoice : join(app.getAppPath(), 'release/TriageVoiceHelper.app')
    voice = new VoiceSession(new VoicePreferences(directory), (event, lost) => new NativeSpeechAdapter(
      voiceHelper, event, lost), (state) => {
      voiceShortcut?.observe(state)
      if (!quitting && desktop) {
        for (const window of [desktop.chat, desktop.voicePanel]) {
          if (!window.isDestroyed()) window.webContents.send(voiceChannels.state, state)
        }
        if (state.settings.enabled && state.activation === 'hold') desktop.showVoice()
        else desktop.voicePanel.hide()
      }
    }, undefined, {
      reserve: (id) => assistant!.reserveVoice(id),
      release: (id) => assistant!.releaseVoice(id),
      submit: (id, text, conversationId) => assistant!.sendVoice(id, text, conversationId),
      stop: () => assistant!.stopActive(),
      conversation: (id) => assistant!.history.summary(id)
    })
    voiceShortcut = new VoiceShortcut(voice, (event, lost) => new NativeSpeechAdapter(voiceHelper, event, lost))
    voice.setChatOpen(desktop.chat.isVisible())
    removeVoiceIpc = installVoiceIpc(ipcMain, voice, (event) => trusted(event) && event.sender === desktop?.chat.webContents,
      voiceShortcut, (event) => trusted(event) && event.sender === desktop?.voicePanel.webContents)
    desktop.chat.on('show', () => voice?.setChatOpen(true))
    desktop.chat.on('hide', () => voice?.setChatOpen(false))
    await desktop.initialize()
    if (voice.snapshot().settings.enabled) {
      void voiceShortcut.setup(false).catch(() => { /* Settings offers an explicit retry. */ })
    }
    const interrupt = (message: string) => {
      assistant?.interrupt(message)
      screens?.clear()
      highlights?.clear()
    }
    const reset = () => { shakeMonitor?.reset(); interrupt('Interrupted because the display configuration changed.') }
    const paused = new Set<string>()
    const sleep = () => { paused.add('sleep'); voiceShortcut?.suspend(); voice?.suspend(); shakeMonitor?.pause(); interrupt('Interrupted because this Mac went to sleep.') }
    const lock = () => { paused.add('lock'); voiceShortcut?.suspend(); voice?.suspend(); shakeMonitor?.pause(); interrupt('Interrupted because this Mac was locked.') }
    const wake = () => { paused.delete('sleep'); if (!paused.size) { shakeMonitor?.resume(); voice?.resume(); voiceShortcut?.resume() } }
    const unlock = () => { paused.delete('lock'); if (!paused.size) { shakeMonitor?.resume(); voice?.resume(); voiceShortcut?.resume() } }
    powerMonitor.on('suspend', sleep)
    powerMonitor.on('resume', wake)
    powerMonitor.on('lock-screen', lock)
    powerMonitor.on('unlock-screen', unlock)
    screen.on('display-added', reset)
    screen.on('display-removed', reset)
    screen.on('display-metrics-changed', reset)
    removeShakeListeners = () => {
      powerMonitor.removeListener('suspend', sleep)
      powerMonitor.removeListener('resume', wake)
      powerMonitor.removeListener('lock-screen', lock)
      powerMonitor.removeListener('unlock-screen', unlock)
      screen.removeListener('display-added', reset)
      screen.removeListener('display-removed', reset)
      screen.removeListener('display-metrics-changed', reset)
    }
    shakeMonitor.start()

    tray = new Tray(createTrayIcon())
    tray.setToolTip('Triage — your desktop companion')
    tray.setContextMenu(buildControls())

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Triage',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Show Triage', click: () => desktop?.show() },
          { label: 'Open chat', click: () => desktop?.openChat() },
          { label: 'Hide Triage', click: () => desktop?.hide() },
          { type: 'separator' },
          { role: 'quit', label: 'Quit Triage' }
        ]
      },
      { role: 'editMenu' },
      { label: 'Window', submenu: [{ role: 'close' }] }
    ]))

    const emergency = globalShortcut.register('CommandOrControl+Shift+Escape', () => assistant?.stopActive())
    if (!emergency) console.warn('Emergency Stop shortcut unavailable; use Stop in chat or the menu bar.')
    const registered = globalShortcut.register('CommandOrControl+Shift+Space', () => desktop?.openChat())
    desktop.setShortcutAvailable(registered)
    if (!registered) console.warn('Triage shortcut is unavailable; use the menu bar or Dock to restore it.')
  }).catch((error: unknown) => {
    console.error('Triage startup failed:', error instanceof AppProblem ? error.code : 'startup')
    dialog.showErrorBox('Triage could not start', error instanceof AppProblem ? error.message :
      'Triage could not initialize its desktop resources. Quit and restart it. Screen Recording permission is needed only for screen help.')
    app.quit()
  })
}
