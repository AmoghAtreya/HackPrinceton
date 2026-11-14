import { BrowserWindow, screen, type WebContents } from 'electron'
import { join } from 'node:path'
import { channels, type CompanionMood, type DesktopState } from '../shared/contracts'
import { clampPosition, readPosition, writePosition } from './position-store'

const COMPANION_SIZE = { width: 128, height: 144 }
const CHAT_SIZE = { width: 392, height: 540 }

interface DragSession {
  cursor: Electron.Point
  origin: Electron.Point
  startedAt: number
  moved: boolean
}

export class DesktopWindows {
  readonly companion: BrowserWindow
  readonly chat: BrowserWindow
  readonly voicePanel: BrowserWindow
  private mood: CompanionMood = 'greeting'
  private thinking = false
  private shortcutAvailable = false
  private drag?: DragSession
  private dragTimer?: ReturnType<typeof setInterval>
  private greetingTimer?: ReturnType<typeof setTimeout>
  private positionFile: string
  private quitting = false
  private visibilityVersion = 0
  isCapturing = false

  constructor(userData: string) {
    this.positionFile = join(userData, 'companion-position.json')
    const area = screen.getPrimaryDisplay().workArea
    const saved = readPosition(this.positionFile)
    const initial = saved ?? {
      x: area.x + area.width - COMPANION_SIZE.width - 30,
      y: area.y + area.height - COMPANION_SIZE.height - 24
    }
    const targetArea = saved ? screen.getDisplayNearestPoint(saved).workArea : area
    const position = clampPosition(initial, targetArea, COMPANION_SIZE)
    const webPreferences = {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }

    this.companion = new BrowserWindow({
      ...COMPANION_SIZE, ...position,
      title: 'Triage', show: false, frame: false, transparent: true,
      resizable: false, maximizable: false, minimizable: false,
      fullscreenable: false, hasShadow: false, alwaysOnTop: true,
      focusable: false, webPreferences
    })
    this.chat = new BrowserWindow({
      ...CHAT_SIZE,
      title: 'Triage — Chat', show: false, frame: false, transparent: true,
      resizable: false, maximizable: false, minimizable: false,
      fullscreenable: false, hasShadow: false, alwaysOnTop: true,
      webPreferences
    })

    this.voicePanel = new BrowserWindow({
      width: 380, height: 245, title: 'Triage — Voice', show: false,
      frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, webPreferences
    })
    for (const window of [this.companion, this.chat, this.voicePanel]) {
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      window.on('close', (event) => {
        if (!this.quitting) {
          event.preventDefault()
          if (window === this.voicePanel) this.voicePanel.hide()
          else if (window === this.chat) this.closeChat()
          else this.hide()
        }
      })
    }

    this.companion.setIgnoreMouseEvents(true, { forward: true })
    this.companion.on('move', () => { if (this.chat.isVisible()) this.positionChat() })
    screen.on('display-removed', this.reconcileDisplays)
    screen.on('display-metrics-changed', this.reconcileDisplays)
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.loadView(this.companion, 'companion'),
      this.loadView(this.chat, 'chat'),
      this.loadView(this.voicePanel, 'voice')
    ])
    this.show()
    this.greetingTimer = setTimeout(() => {
      this.mood = this.thinking ? 'thinking' : 'idle'
      this.publish()
    }, 1800)
  }

  private async loadView(window: BrowserWindow, view: string): Promise<void> {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) {
      const url = new URL(devUrl)
      url.searchParams.set('view', view)
      await window.loadURL(url.toString())
    } else {
      await window.loadFile(join(__dirname, '../renderer/index.html'), { query: { view } })
    }
  }

  owns(contents: WebContents): boolean {
    return contents === this.companion.webContents || contents === this.chat.webContents || contents === this.voicePanel.webContents
  }

  getState(): DesktopState {
    return {
      visible: this.companion.isVisible(),
      chatOpen: this.chat.isVisible(),
      mood: this.mood,
      shortcutAvailable: this.shortcutAvailable
    }
  }

  setShortcutAvailable(value: boolean): void {
    this.shortcutAvailable = value
    this.publish()
  }

  setThinking(value: boolean): void {
    this.thinking = value
    if (!this.drag?.moved) this.mood = value ? 'thinking' : 'idle'
    this.publish()
  }

  private publish(): void {
    if (this.quitting) return
    const state = this.getState()
    for (const window of [this.companion, this.chat]) {
      if (!window.isDestroyed()) window.webContents.send(channels.state, state)
    }
  }

  coversTarget(target: { x: number; y: number; width: number; height: number }): boolean {
    return [this.companion, this.chat, this.voicePanel].some((window) => {
      if (window.isDestroyed() || !window.isVisible()) return false
      const bounds = window.getBounds()
      return target.x < bounds.x + bounds.width && target.x + target.width > bounds.x &&
        target.y < bounds.y + bounds.height && target.y + target.height > bounds.y
    })
  }

  showVoice(): void {
    if (this.quitting || this.isCapturing || this.voicePanel.isVisible()) return
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    this.voicePanel.setPosition(area.x + area.width - 400, area.y + 24, false)
    this.voicePanel.showInactive()
  }

  get isDragging(): boolean { return Boolean(this.drag) }

  hideForCapture(focusAfterCapture = true): () => void {
    this.isCapturing = true
    const version = this.visibilityVersion
    const companionVisible = this.companion.isVisible()
    const chatVisible = this.chat.isVisible()
    this.finishDrag(false)
    this.companion.hide()
    this.chat.hide()
    const voiceVisible = this.voicePanel.isVisible()
    this.voicePanel.hide()
    return () => {
      this.isCapturing = false
      if (this.quitting || version !== this.visibilityVersion) return
      if (voiceVisible) this.voicePanel.showInactive()
      if (companionVisible) this.companion.showInactive()
      if (chatVisible) {
        if (focusAfterCapture) { this.chat.show(); this.chat.focus() }
        else this.chat.showInactive()
      }
      this.publish()
    }
  }

  show(): void {
    this.visibilityVersion++
    this.reconcileDisplays()
    this.companion.showInactive()
    this.publish()
  }

  hide(): void {
    this.visibilityVersion++
    this.finishDrag(false)
    this.chat.hide()
    this.voicePanel.hide()
    this.companion.hide()
    this.publish()
  }

  openChat(): void {
    this.show()
    this.positionChat()
    this.chat.show()
    this.chat.focus()
    this.publish()
  }

  toggleChat(): void {
    if (this.chat.isVisible()) this.closeChat()
    else this.openChat()
  }

  closeChat(): void {
    this.visibilityVersion++
    this.chat.hide()
    this.publish()
  }

  setPointerInteractive(interactive: boolean): void {
    if (!this.drag) this.companion.setIgnoreMouseEvents(!interactive, { forward: true })
  }

  beginDrag(cursor: Electron.Point): void {
    if (this.drag || !this.companion.isVisible()) return
    if (this.greetingTimer) clearTimeout(this.greetingTimer)
    const [x, y] = this.companion.getPosition()
    this.drag = { cursor, origin: { x, y }, startedAt: Date.now(), moved: false }
    this.companion.setIgnoreMouseEvents(false)
    this.dragTimer = setInterval(() => this.updateDrag(), 16)
  }

  private updateDrag(cursor = screen.getCursorScreenPoint()): void {
    const drag = this.drag
    if (!drag) return
    if (Date.now() - drag.startedAt > 15000) {
      this.finishDrag(false)
      return
    }
    const dx = cursor.x - drag.cursor.x
    const dy = cursor.y - drag.cursor.y
    if (!drag.moved && Math.hypot(dx, dy) < 6) return
    if (!drag.moved) {
      drag.moved = true
      this.mood = 'moving'
      this.closeChat()
    }
    const area = screen.getDisplayNearestPoint(cursor).workArea
    const position = clampPosition({ x: drag.origin.x + dx, y: drag.origin.y + dy }, area, COMPANION_SIZE)
    this.companion.setPosition(position.x, position.y, false)
  }

  finishDrag(allowClick = true, finalPoint?: Electron.Point): void {
    // Include movement since the last polling tick before deciding this was a click.
    if (allowClick && this.drag && Date.now() - this.drag.startedAt <= 15000) this.updateDrag(finalPoint)
    const drag = this.drag
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = undefined
    this.drag = undefined
    if (!drag) return
    this.mood = this.thinking ? 'thinking' : 'idle'
    const [x, y] = this.companion.getPosition()
    const cursor = finalPoint ?? screen.getCursorScreenPoint()
    const inside = allowClick && cursor.x >= x && cursor.x < x + COMPANION_SIZE.width &&
      cursor.y >= y && cursor.y < y + COMPANION_SIZE.height
    // Native movement can finish after the renderer's mouse-up coordinates were
    // calculated. Hit-test against the final window, not the pre-move DOM frame.
    this.companion.setIgnoreMouseEvents(!inside, { forward: true })
    writePosition(this.positionFile, { x, y })
    if (allowClick && !drag.moved) this.toggleChat()
    else this.publish()
  }

  private positionChat(): void {
    const bounds = this.companion.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const width = Math.min(CHAT_SIZE.width, area.width)
    const height = Math.min(CHAT_SIZE.height, area.height)
    const rightX = bounds.x + bounds.width + 8
    const leftX = bounds.x - width - 8
    const preferredX = leftX >= area.x ? leftX : rightX
    const position = clampPosition(
      { x: preferredX, y: bounds.y + bounds.height - height },
      area, { width, height }
    )
    this.chat.setBounds({ ...position, width, height }, false)
  }

  private reconcileDisplays = (): void => {
    if (this.quitting) return
    this.finishDrag(false)
    const bounds = this.companion.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const position = clampPosition(bounds, area, COMPANION_SIZE)
    this.companion.setPosition(position.x, position.y, false)
    if (this.chat.isVisible()) this.positionChat()
    writePosition(this.positionFile, position)
  }

  dispose(): void {
    this.quitting = true
    if (this.dragTimer) clearInterval(this.dragTimer)
    if (this.greetingTimer) clearTimeout(this.greetingTimer)
    screen.removeListener('display-removed', this.reconcileDisplays)
    screen.removeListener('display-metrics-changed', this.reconcileDisplays)
    if (!this.companion.isDestroyed()) {
      const [x, y] = this.companion.getPosition()
      writePosition(this.positionFile, { x, y })
    }
    for (const window of [this.chat, this.companion, this.voicePanel]) {
      if (!window.isDestroyed()) window.destroy()
    }
  }
}
