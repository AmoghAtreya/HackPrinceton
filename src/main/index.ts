import { PhishingMonitor } from './phishing/monitor'
import { BrowserSupervisor } from './browser/supervisor'
import { VoiceController, type VoiceEvent } from './voice/controller'
import { TranscribeService, transcribeConfigFromEnv } from './voice/transcribe'
import { AppleSpeechService } from './voice/apple-speech'
import { GeminiTranscriber } from './voice/gemini-transcriber'
import { VoiceKeyStore } from './voice/voice-key'
import { isGeminiKey } from './assistant/gemini'
import { LocalTranscriptStore } from './voice/transcript-store'
import { ensureMicrophoneAccess } from './voice/microphone'
import { installVoiceIpc } from './voice/ipc'
import { voiceChannels } from '../shared/voice-contracts'
import { PollyService } from './speech/polly'
import { SpeechPreferences } from './speech/settings'
import { installSpeechIpc } from './speech/ipc'
import { LocalRequestLog } from './logging/request-log'
import { installRequestLogIpc } from './logging/ipc'
import { createSimplifier } from './simplifier/index'
import { SimplifierService } from './simplifier/service'
import { SimplifiedWindow } from './simplifier/window'
import { ScreenSimplifier } from './simplifier/screen'
import { ThompsonPolicy } from './simplifier/thompson'
import demoPageHtml from '../../demo/sites/cluttered-news.html?raw'
import pharmacyPageHtml from '../../demo/sites/pharmacy-refill.html?raw'
import { MemoryService } from './memory/service'
import { SqliteCheckpointer } from './tasks/checkpointer'
import { DemoPharmacyDriver } from './tasks/pharmacy-driver'
import { TaskRunner } from './tasks/runner'
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
import { GeminiGateway, ProviderGateway } from './assistant/gemini'
import { installAssistantIpc } from './assistant/ipc'
import { ScreenService } from './screen/service'
import { ContextService } from './context/service'
import { PairedCapture } from './context/paired-capture'
import { electronContext } from './context/electron-context'
import { screenContextBlock } from './context/chat-context'
import { TrustStore } from './trust/store'
import { TrustService } from './trust/service'
import { seedStore } from './trust/seed'
import { installTrustIpc } from './trust/ipc'
import { trustChannels } from '../shared/trust-contracts'
import { SkillStore } from './skills/store'
import { SkillTutor } from './skills/tutor'
import { installSkillsIpc } from './skills/ipc'
import { electronCapture } from './screen/electron-capture'
import { HighlightController } from './screen/highlight'
import { OverlayWindow } from './screen/overlay-window'
import { observeTargetClick } from './screen/target-click'
import { ShakePreferences } from './gestures/settings'
import { ShakeMonitor } from './gestures/monitor'
import { redact } from './assistant/redaction'
import { AppProblem, publicProblem } from './assistant/errors'
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
let chatContexts: ContextService | undefined
let trust: TrustService | undefined
let trustContexts: ContextService | undefined
let trustTimer: ReturnType<typeof setInterval> | undefined
let trustChecking = false
let removeTrustIpc: (() => void) | undefined
let tutor: SkillTutor | undefined
let removeSkillsIpc: (() => void) | undefined
let warnedAbout: string | undefined

// Looks at what is in front every few seconds and compares it with the user's list. Reads only.
function setTrustMonitoring(on: boolean): void {
  clearInterval(trustTimer)
  trustTimer = undefined
  trust?.setMonitoring(on && Boolean(trustContexts))
  if (!on || !trust || !trustContexts) return
  trustTimer = setInterval(() => {
    if (trustChecking || quitting || desktop?.isCapturing) return
    trustChecking = true
    trustContexts!.capture().then((snapshot) => { trustContexts?.clear(); trust?.inspect(snapshot) })
      .catch((error: unknown) => {
        if (!(error instanceof AppProblem) || error.code !== 'context_permission') return
        setTrustMonitoring(false)
        tray?.setContextMenu(buildControls())
        dialog.showErrorBox('Scam warnings paused', 'In System Settings → Privacy & Security → Accessibility, enable Triage, then turn the warnings back on.')
      }).finally(() => { trustChecking = false })
  }, 3000)
}
let highlights: HighlightController | undefined
let overlay: OverlayWindow | undefined
let assistant: AssistantCoordinator | undefined
let browser: BrowserSupervisor | undefined
let simplifier: SimplifierService | undefined
let simplifiedWindow: SimplifiedWindow | undefined
let screenSimplifier: ScreenSimplifier | undefined
let closeSimplifierLog: (() => void) | undefined
let memory: MemoryService | undefined
let tasks: TaskRunner | undefined
let checkpointer: SqliteCheckpointer | undefined
let shutdownReady = false
let removeAssistantIpc: (() => void) | undefined
let shakeMonitor: ShakeMonitor | undefined
let removeShakeListeners: (() => void) | undefined
let presentedGesture: string | undefined
let voice: VoiceController | undefined
let phishing: PhishingMonitor | undefined
let phishingEnabled = false
let removeVoiceIpc: (() => void) | undefined
let polly: PollyService | undefined
let removeSpeechIpc: (() => void) | undefined
let removeRequestLogIpc: (() => void) | undefined

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
      // Reads the page in front and shows a simpler version. It never clicks anything on the page.
      label: 'Simplify this page', enabled: Boolean(screenSimplifier), click: () => {
        try { assistant?.simplifyPage() }
        catch (error) { dialog.showErrorBox('Triage could not simplify this page', publicProblem(error).message) }
      }
    },
    {
      label: 'Chrome Link Warnings (Preview)', type: 'checkbox', checked: phishingEnabled,
      enabled: Boolean(phishing), click: (item) => {
        phishingEnabled = item.checked
        if (phishingEnabled) phishing?.start(true)
        else phishing?.stop()
        tray?.setContextMenu(buildControls())
      }
    },
    {
      label: 'Warn About Impersonation (Preview)', type: 'checkbox', checked: Boolean(trustTimer),
      enabled: Boolean(trust && trustContexts), click: (item) => { setTrustMonitoring(item.checked); tray?.setContextMenu(buildControls()) }
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
      () => removeVoiceIpc?.(), () => voice?.dispose(), () => phishing?.stop(), () => setTrustMonitoring(false),
      () => removeTrustIpc?.(), () => trustContexts?.dispose(), () => trust?.dispose(),
      () => removeSkillsIpc?.(), () => tutor?.dispose(),
      () => removeSpeechIpc?.(), () => polly?.dispose(), () => removeRequestLogIpc?.(),
      () => globalShortcut.unregisterAll(), () => shakeMonitor?.dispose(),
      () => removeShakeListeners?.(), () => removeAssistantIpc?.(),
      () => assistant?.dispose(), () => screens?.dispose(), () => contexts?.dispose(), () => chatContexts?.dispose(),
      () => highlights?.dispose(), () => overlay?.dispose(),
      () => desktop?.dispose(), () => tray?.destroy(), () => screenSimplifier?.dispose(), () => simplifiedWindow?.dispose(),
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
      for (const close of [() => closeSimplifierLog?.(), () => tasks?.close(), () => checkpointer?.close(), () => memory?.close()]) {
        try { close() } catch { /* Already closed. */ }
      }
      shutdownReady = true; app.quit()
    })
  })

  app.whenReady().then(async () => {
    const directory = app.getPath('userData')
    const secretCrypto = {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (text: string) => safeStorage.encryptStringAsync(text),
      decrypt: (bytes: Buffer) => safeStorage.decryptStringAsync(bytes)
    }
    const credentials = new Credentials(directory, secretCrypto)
    await credentials.initialize()
    // A Gemini key used only for voice transcription; the chatbot key can stay Anthropic.
    const voiceKeys = new VoiceKeyStore(directory, secretCrypto)
    await voiceKeys.initialize()
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
    // Its own instance: a chat message must not replace the snapshot paired with a pending screenshot.
    chatContexts = accessibility ? new ContextService(accessibility.port) : undefined
    trustContexts = accessibility ? new ContextService(accessibility.port) : undefined
    // The trust graph is optional equipment: if it cannot be opened, everything else still works.
    try {
      const store = new TrustStore(join(directory, 'trust-graph.sqlite'))
      seedStore(store)
      trust = new TrustService(store, (state) => {
        if (!desktop || quitting) return
        if (!desktop.chat.isDestroyed()) desktop.chat.webContents.send(trustChannels.state, state)
        // A new warning is worth interrupting for, once.
        if (state.warning && state.warning.key !== warnedAbout && !desktop.isCapturing) desktop.openChat()
        warnedAbout = state.warning?.key
      })
    } catch { console.warn('The list of people and organizations is unavailable.') }
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
      (cursor) => captures?.privateFields(cursor) ?? Promise.resolve(null)))
    captures = new PairedCapture(screens, contexts)
    browser = new BrowserSupervisor(() => utilityProcess.fork(join(__dirname, 'browser-worker.js'), [], {
      serviceName: 'Triage flight search', stdio: 'ignore',
      env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []))
    }), join(directory, 'browser-profile'), () => highlights?.clear(), configuredBrowserChannel())
    // Optional, like the trust graph: without it Triage explains everything and the learner sees neutral knowledge.
    try { tutor = new SkillTutor(new SkillStore(join(directory, 'skill-knowledge.sqlite'))) }
    catch { console.warn('The record of what you have learned is unavailable.') }
    const simplifierParts = createSimplifier(directory, tutor ? { knowledge: (userId, pageType) => tutor!.features(userId, pageType) } : {})
    closeSimplifierLog = simplifierParts.close
    simplifiedWindow = new SimplifiedWindow((url) => { void simplifier?.open(url) },
      () => { simplifier?.viewClosed(); screenSimplifier?.viewClosed() }, (link) => screenSimplifier?.handle(link))
    const policy = simplifierParts.policy
    simplifier = new SimplifierService({
      engine: simplifierParts.engine, presenter: simplifiedWindow, channel: configuredBrowserChannel(), demoHtml: demoPageHtml,
      log: simplifierParts.log, lockedLayouts: (userId) => (policy instanceof ThompsonPolicy ? policy.frozenArms(userId) : {}),
      observed: (decisionId) => screenSimplifier?.signals(decisionId),
      reported: (userId, pageType, signals) => tutor?.observePage(userId, pageType, signals)
    })
    // Needs the accessibility module; its only powers over the real page are reading it and drawing a highlight.
    screenSimplifier = contexts && accessibility ? new ScreenSimplifier({
      contexts, engine: simplifierParts.engine, presenter: simplifiedWindow, highlights, probe: accessibility.frameOf
    }) : undefined
    const requestLog = new LocalRequestLog(directory, app.getVersion())
    // Personal memory (LangChain vector store) and multi-step tasks (LangGraph),
    // both stored only in this Mac's Triage data folder.
    memory = new MemoryService(join(directory, 'memory.sqlite'))
    checkpointer = new SqliteCheckpointer(join(directory, 'tasks.sqlite'))
    tasks = new TaskRunner({
      file: join(directory, 'tasks.sqlite'), memory, checkpointer,
      driver: new DemoPharmacyDriver(() => simplifier!.browserPage(), pharmacyPageHtml)
    })
    assistant = new AssistantCoordinator({
      requestLog,
      history: new HistoryStore(join(directory, 'history.sqlite')),
      credentials, gateway: new ProviderGateway(new ClaudeGateway(), new GeminiGateway()), screens, contexts: captures, highlights, browser, simplifier, screenSimplifier, memory, tasks,
      // Labels only, and only what is frontmost. Without Accessibility access chat simply gets no block.
      screenContext: async () => {
        if (!chatContexts) return undefined
        const snapshot = await chatContexts.capture()
        chatContexts.clear()
        trust?.inspect(snapshot)
        return screenContextBlock(snapshot)
      },
      captureScreen: () => captures!.capture(), trust, tutor,
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
          if (shake.snapshot().mode === 'simplify') { assistant.simplifyPage(); return }
          assistant.shake(trigger, shake.snapshot().instruction,
            () => captures!.capture({ cursor: trigger.point, focusAfterCapture: false }), shake.snapshot().mode === 'highlight' ? 'highlight' : 'explain')
        } catch { /* The coordinator publishes a blocking notice if history cannot be saved. */ }
      }
    })
    installIpc()
    if (tutor) removeSkillsIpc = installSkillsIpc(tutor, (event) => trusted(event) && event.sender === desktop?.chat.webContents)
    if (trust) removeTrustIpc = installTrustIpc(trust, (event) => trusted(event) && event.sender === desktop?.chat.webContents)
    removeAssistantIpc = installAssistantIpc(assistant, (event) => trusted(event) && event.sender === desktop?.chat.webContents,
      captures, shake, () => shakeMonitor?.reset())
    const speechPreferences = new SpeechPreferences(directory)
    // Gemini key for voice, in order: the voice-only key, a Gemini chatbot key, then GEMINI_API_KEY.
    const geminiVoiceKeyWithSource = (): { key: string; source: 'voice' | 'chatbot' | 'env' } | null => {
      const voiceOnly = voiceKeys.get()
      if (voiceOnly) return { key: voiceOnly, source: 'voice' }
      try { const key = credentials.getKey(); if (isGeminiKey(key)) return { key, source: 'chatbot' } } catch { /* No chatbot key connected. */ }
      const fromEnv = process.env.GEMINI_API_KEY?.trim()
      return fromEnv && isGeminiKey(fromEnv) ? { key: fromEnv, source: 'env' } : null
    }
    const geminiVoiceKey = (): string | null => geminiVoiceKeyWithSource()?.key ?? null
    const geminiTranscriber = new GeminiTranscriber()
    voice = new VoiceController({
      // Free on-device Apple speech by default; TRIAGE_SPEECH_TO_TEXT=transcribe uses Amazon Transcribe.
      service: process.env.TRIAGE_SPEECH_TO_TEXT === 'transcribe' || process.platform !== 'darwin'
        ? new TranscribeService(transcribeConfigFromEnv())
        : new AppleSpeechService(existsSync(join(process.resourcesPath, '../Helpers/TriageSpeechHelper.app'))
          ? join(process.resourcesPath, '../Helpers/TriageSpeechHelper.app')
          : join(app.getAppPath(), 'release/TriageSpeechHelper.app')),
      store: new LocalTranscriptStore(directory),
      ensureMicrophone: ensureMicrophoneAccess,
      // Apple writes the live captions; Gemini writes the final transcript when it can.
      finalTranscriber: async (recording, sampleRate, signal) => {
        const key = geminiVoiceKey()
        if (!key || !speechPreferences.snapshot().geminiTranscription) return null
        return geminiTranscriber.transcribe(key, recording, sampleRate, signal)
      }
    })
    voice.subscribe((event: VoiceEvent) => {
      if (quitting || !desktop || desktop.chat.isDestroyed()) return
      if (event.type === 'speech_state') desktop.chat.webContents.send(voiceChannels.state, event)
      else if (event.type === 'user_utterance') desktop.chat.webContents.send(voiceChannels.utterance, event)
      // event.type === 'transcript': a finished, stored recording. The agent layer hooks in here.
    })
    removeVoiceIpc = installVoiceIpc(ipcMain, voice, (event) => trusted(event) && event.sender === desktop?.chat.webContents)
    removeRequestLogIpc = installRequestLogIpc(ipcMain, requestLog, (event) => trusted(event) && event.sender === desktop?.chat.webContents)
    polly = new PollyService()
    removeSpeechIpc = installSpeechIpc(ipcMain, polly, speechPreferences,
      (event) => trusted(event) && event.sender === desktop?.chat.webContents, {
        status: () => { const found = geminiVoiceKeyWithSource(); return { geminiKeyAvailable: Boolean(found), geminiKeySource: found?.source ?? null, geminiVoiceKey: voiceKeys.status() } },
        set: async (key, remember) => { await voiceKeys.set(key, remember) },
        remove: () => { voiceKeys.remove() }
      })
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
