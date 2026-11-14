import { PhishingMonitor } from './phishing/monitor'
import { BrowserSupervisor } from './browser/supervisor'
import { VoiceController, type VoiceEvent } from './voice/controller'
import { TranscribeService, transcribeConfigFromEnv } from './voice/transcribe'
import { LocalTranscriptStore } from './voice/transcript-store'
import { ensureMicrophoneAccess } from './voice/microphone'
import { installVoiceIpc } from './voice/ipc'
import { voiceChannels } from '../shared/voice-contracts'
import { createSimplifier } from './simplifier/index'
import { SimplifierService } from './simplifier/service'
import { SimplifiedWindow } from './simplifier/window'
import { ThompsonPolicy } from './simplifier/thompson'
import demoPageHtml from '../../demo/sites/cluttered-news.html?raw'
import { app, utilityProcess, dialog, globalShortcut, ipcMain, Menu, Tray, safeStorage, screen, powerMonitor, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
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
import { ContextService } from './context/service'
import { PairedCapture } from './context/paired-capture'
import { electronContext } from './context/electron-context'
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
let contexts: ContextService | undefined
let captures: PairedCapture | undefined
let highlights: HighlightController | undefined
let overlay: OverlayWindow | undefined
let assistant: AssistantCoordinator | undefined
let browser: BrowserSupervisor | undefined
let simplifier: SimplifierService | undefined
let simplifiedWindow: SimplifiedWindow | undefined
let closeSimplifierLog: (() => void) | undefined
let shutdownReady = false
let removeAssistantIpc: (() => void) | undefined
let shakeMonitor: ShakeMonitor | undefined
let removeShakeListeners: (() => void) | undefined
let presentedGesture: string | undefined
let voice: VoiceController | undefined
let phishing: PhishingMonitor | undefined
let phishingEnabled = false
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
    {
      label: 'Chrome Link Warnings (Preview)', type: 'checkbox', checked: phishingEnabled,
      enabled: Boolean(phishing), click: (item) => {
        phishingEnabled = item.checked
        if (phishingEnabled) phishing?.start(true)
        else phishing?.stop()
        tray?.setContextMenu(buildControls())
      }
    },
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
    const cleanup = [
      () => removeVoiceIpc?.(), () => voice?.dispose(), () => phishing?.stop(),
      () => globalShortcut.unregisterAll(), () => shakeMonitor?.dispose(),
      () => removeShakeListeners?.(), () => removeAssistantIpc?.(),
      () => assistant?.dispose(), () => screens?.dispose(), () => contexts?.dispose(),
      () => highlights?.dispose(), () => overlay?.dispose(),
      () => desktop?.dispose(), () => tray?.destroy(), () => simplifiedWindow?.dispose(),
      () => {
        ipcMain.removeHandler(channels.getState)
        for (const channel of Object.values(channels)) ipcMain.removeAllListeners(channel)
      }
    ]
    for (const close of cleanup) {
      try { close() } catch { console.warn('A Triage resource could not finish closing.') }
    }
    void Promise.all([browser?.close(), simplifier?.close()]).catch(() => {
      console.warn('Triage browser shutdown failed.')
    }).finally(() => {
      try { closeSimplifierLog?.() } catch { /* The log may already be closed. */ }
      shutdownReady = true; app.quit()
    })
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
    if (process.platform === 'darwin') {
      const bundledScanner = join(process.resourcesPath, '../Helpers/TriageLinkScanner.node')
      const helper = app.isPackaged || existsSync(bundledScanner)
        ? bundledScanner : join(app.getAppPath(), 'release/TriageLinkScanner.node')
      phishing = new PhishingMonitor(helper, () => Boolean(quitting || desktop?.isCapturing),
        (state) => overlay?.drawWarnings(state), (permissionDenied) => {
          phishingEnabled = false
          tray?.setContextMenu(buildControls())
          dialog.showErrorBox('Chrome Link Warnings paused', permissionDenied
            ? 'In System Settings → Privacy & Security → Accessibility, enable Triage, then turn Link Warnings back on.'
            : 'Run npm run phishing:build. If using Triage.app, rebuild the bundle before turning Link Warnings back on.')
        })
    }
    // Optional: without this module (or without Accessibility access) highlights use pixel boxes.
    const bundledContext = join(process.resourcesPath, '../Helpers/TriageContextSnapshot.node')
    const accessibility = process.platform === 'darwin' ? electronContext(app.isPackaged || existsSync(bundledContext)
      ? bundledContext : join(app.getAppPath(), 'release/TriageContextSnapshot.node')) : undefined
    contexts = accessibility ? new ContextService(accessibility.port) : undefined
    highlights = new HighlightController({
      display: (id) => overlay!.display(id), draw: (state) => overlay!.draw(state), hide: () => overlay!.hide(),
      redraw: (state) => overlay!.redraw(state),
      blocked: (target) => desktop!.coversTarget(target), observeClick: observeTargetClick,
      ...(accessibility ? { frameOf: accessibility.frameOf } : {})
    })
    const clearMovedMarker = () => { if (highlights?.snapshot()) highlights.clear() }
    desktop.companion.on('move', clearMovedMarker)
    desktop.chat.on('move', clearMovedMarker)
    for (const window of [desktop.chat, desktop.companion]) {
      window.on('show', () => overlay?.refreshArrow())
      window.on('hide', () => overlay?.refreshArrow())
    }
    screens = new ScreenService(electronCapture(desktop, () => phishing?.clear(),
      (cursor) => captures?.snapshotContext(cursor) ?? Promise.resolve()))
    captures = new PairedCapture(screens, contexts)
    browser = new BrowserSupervisor(() => utilityProcess.fork(join(__dirname, 'browser-worker.js'), [], {
      serviceName: 'Triage flight search', stdio: 'ignore',
      env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []))
    }), join(directory, 'browser-profile'), () => highlights?.clear(), configuredBrowserChannel())
    const simplifierParts = createSimplifier(directory)
    closeSimplifierLog = simplifierParts.close
    simplifiedWindow = new SimplifiedWindow((url) => { void simplifier?.open(url) }, () => simplifier?.viewClosed())
    const policy = simplifierParts.policy
    simplifier = new SimplifierService({
      engine: simplifierParts.engine, presenter: simplifiedWindow, channel: configuredBrowserChannel(), demoHtml: demoPageHtml,
      log: simplifierParts.log, lockedLayouts: (userId) => (policy instanceof ThompsonPolicy ? policy.frozenArms(userId) : {})
    })
    assistant = new AssistantCoordinator({
      history: new HistoryStore(join(directory, 'history.sqlite')),
      credentials, gateway: new ClaudeGateway(), screens, contexts: captures, highlights, browser, simplifier,
      // The coordinator only passes URLs already checked against the destination allowlist.
      openPage: (url) => shell.openExternal(url, { activate: true }),
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
        if (!assistant || !captures || quitting) return
        try {
          assistant.shake(trigger, shake.snapshot().instruction,
            () => captures!.capture({ cursor: trigger.point, focusAfterCapture: false }), shake.snapshot().mode)
        } catch { /* The coordinator publishes a blocking notice if history cannot be saved. */ }
      }
    })
    installIpc()
    removeAssistantIpc = installAssistantIpc(assistant, (event) => trusted(event) && event.sender === desktop?.chat.webContents,
      captures, shake, () => shakeMonitor?.reset())
    voice = new VoiceController({
      service: new TranscribeService(transcribeConfigFromEnv()),
      store: new LocalTranscriptStore(directory),
      ensureMicrophone: ensureMicrophoneAccess
    })
    voice.subscribe((event: VoiceEvent) => {
      if (quitting || !desktop || desktop.chat.isDestroyed()) return
      if (event.type === 'speech_state') desktop.chat.webContents.send(voiceChannels.state, event)
      else if (event.type === 'user_utterance') desktop.chat.webContents.send(voiceChannels.utterance, event)
      // event.type === 'transcript': a finished, stored recording. The agent layer hooks in here.
    })
    removeVoiceIpc = installVoiceIpc(ipcMain, voice, (event) => trusted(event) && event.sender === desktop?.chat.webContents)
    await desktop.initialize()
    const interrupt = (message: string) => {
      assistant?.interrupt(message)
      captures?.clear()
      highlights?.clear()
    }
    const reset = () => { phishing?.clear(); shakeMonitor?.reset(); interrupt('Interrupted because the display configuration changed.') }
    const paused = new Set<string>()
    const sleep = () => { paused.add('sleep'); phishing?.stop(); voice?.interrupt(); shakeMonitor?.pause(); interrupt('Interrupted because this Mac went to sleep.') }
    const lock = () => { paused.add('lock'); phishing?.stop(); voice?.interrupt(); shakeMonitor?.pause(); interrupt('Interrupted because this Mac was locked.') }
    const wake = () => { paused.delete('sleep'); if (!paused.size) { if (phishingEnabled) phishing?.start(); shakeMonitor?.resume() } }
    const unlock = () => { paused.delete('lock'); if (!paused.size) { if (phishingEnabled) phishing?.start(); shakeMonitor?.resume() } }
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
