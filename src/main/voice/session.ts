import { randomUUID } from 'node:crypto'
import type { VoiceAvailability, VoiceState, VoiceContext, VoiceShortcutState } from '../../shared/voice-contracts.ts'
import type { AdapterFactory, SpeechAdapter, SpeechEvent } from './adapter.ts'
import { VoicePreferences } from './settings.ts'
import { needsVoiceScreen, voiceControl } from './commands.ts'
import type { ConversationSummary, SendReceipt } from '../../shared/assistant-contracts.ts'
import { AppProblem, publicProblem } from '../assistant/errors.ts'

export interface VoiceDispatch {
  reserve(id: string): void
  release(id: string): void
  submit(id: string, text: string, conversationId?: string): SendReceipt
  stop(): void
  conversation(id: string): ConversationSummary
}

export interface VoiceDeadlines { start: number; finish: number; capture: number }
const defaults: VoiceDeadlines = { start: 5000, finish: 3000, capture: 45000 }
const recovery = {
  permission: 'Allow Microphone and Speech Recognition for Triage Voice Helper in System Settings → Privacy & Security, then retry setup.',
  unavailable: 'Local English recognition is unavailable. Check installed macOS speech assets and retry setup; no cloud fallback is used.',
  device: 'The selected microphone is unavailable. Reconnect it or choose System default, then retry setup.',
  recognition: 'Speech recognition failed. Edit the draft or retry setup.',
  audio: 'The microphone could not start. Check its device settings, then retry setup.',
  timeout: 'Speech timed out. Edit the draft or start a fresh recording.',
  interrupted: 'Recording was interrupted. Start a fresh recording when ready.',
  overflow: 'Speech exceeded the capture limit. Edit the draft or record a shorter request.'
}
export class VoiceSession {
  private state: VoiceState
  private dispatch?: VoiceDispatch
  private context: VoiceContext = { view: 'chat', conversationId: null }
  private chatOpen = false
  private pinned = false
  private target?: string
  private reservation?: string
  private adapter?: SpeechAdapter
  private epoch = 0
  private pendingSetup = false
  private suspended = false
  private closed = false
  private closing?: Promise<void>
  private afterClose?: { input: VoiceState['input']; notice: string }
  private hold?: { id: string; began: number }
  private timer?: ReturnType<typeof setTimeout>
  private preferences: VoicePreferences
  private factory: AdapterFactory
  private changed: (state: VoiceState) => void
  private deadlines: VoiceDeadlines
  constructor(preferences: VoicePreferences, factory: AdapterFactory,
    changed: (state: VoiceState) => void, deadlines = defaults, dispatch?: VoiceDispatch) {
    this.dispatch = dispatch
    this.preferences = preferences; this.factory = factory; this.changed = changed; this.deadlines = deadlines
    const settings = preferences.snapshot()
    this.state = { conversationId: null, conversationTitle: 'New voice conversation', settings, input: settings.enabled ? 'ready' : 'disabled', availability: null,
      sessionId: null, provisional: '', draft: '', level: 0,
      notice: preferences.warning || 'Set up voice to check permissions. Finish sends your request to the current voice conversation.' }
  }
  snapshot(): VoiceState { return structuredClone(this.state) }
  setChatOpen(open: boolean): void {
    this.chatOpen = open
    if (!open && this.state.sessionId && this.state.activation !== 'hold') this.cancel(this.state.sessionId)
  }
  setContext(context: VoiceContext): VoiceState {
    // Validate the destination before changing it. History navigation alone is not
    // an explicit selection and never changes an already pinned voice target.
    const conversation = context.conversationId ? this.dispatch?.conversation(context.conversationId) : undefined
    const changed = context.conversationId !== this.context.conversationId
    this.context = context
    if (context.explicitSelection || changed) {
      if (this.state.sessionId) {
        this.cancel(this.state.sessionId)
        const notice = 'Conversation changed. Recording cancelled; start a fresh recording.'
        if (this.afterClose) this.afterClose.notice = notice
        else this.state.notice = notice
      }
    }
    if (context.explicitSelection || !this.pinned) {
      this.pinned = Boolean(context.explicitSelection && conversation)
      const destination = this.pinned || this.chatOpen && context.view === 'chat' ? conversation : undefined
      this.state.conversationId = destination?.id ?? null
      this.state.conversationTitle = destination?.title ?? 'New voice conversation'
    }
    return this.publish()
  }
  private releaseInput(): void {
    if (this.reservation) this.dispatch?.release(this.reservation)
    this.reservation = undefined
  }
  private publish(): VoiceState { const state = this.snapshot(); this.changed(state); return state }
  private clearTimer(): void { clearTimeout(this.timer); this.timer = undefined }
  private dropAdapter(): void {
    this.epoch++
    const adapter = this.adapter
    this.adapter = undefined
    this.pendingSetup = false
    try {
      const teardown = adapter?.dispose()
      if (teardown) {
        const closing = Promise.resolve(teardown).catch(() => {}).then(() => {
          if (this.closing !== closing) return
          this.closing = undefined
          const target = this.afterClose
          this.afterClose = undefined
          if (target) this.reset(target.input, target.notice)
        })
        this.closing = closing
      }
    } catch { /* Socket EOF also closes native input. */ }
  }
  private reset(input: VoiceState['input'], notice: string, preserve = false): VoiceState {
    this.clearTimer()
    this.hold = undefined
    if (preserve && this.state.provisional) this.state.draft = this.state.provisional
    if (this.closing) {
      this.afterClose = { input, notice }
      input = 'finalizing'; notice = 'Closing microphone…'
    }
    if (!this.closing) this.releaseInput()
    this.state = { ...this.state, sessionId: null, provisional: '', level: 0, input, notice }
    return this.publish()
  }
  save(input: unknown): VoiceState {
    if (this.closed) throw new AppProblem('voice_closed', 'Voice is shutting down.')
    const settings = this.preferences.save(input)
    // Invalidate before closing resources; a changed device/shortcut never retargets capture.
    this.dropAdapter()
    this.state.settings = settings
    this.state.availability = null
    return this.reset(this.suspended ? 'suspended' : settings.enabled ? 'ready' : 'disabled',
      settings.enabled ? 'Settings saved. Retry setup before recording.' : 'Voice is off. Microphone released.')
  }
  async setup(prompt = true): Promise<VoiceState> {
    this.allowed()
    if (this.state.sessionId || this.pendingSetup || this.closing) throw new AppProblem('busy', 'Finish or cancel the current voice operation first.')
    this.dropAdapter()
    const epoch = this.epoch
    this.pendingSetup = true
    this.state.input = 'starting'
    this.state.notice = 'Checking local speech and requesting voice permissions…'
    this.publish()
    try {
      await this.closing
      if (epoch !== this.epoch) return this.snapshot()
      const adapter = this.factory((event) => { if (epoch === this.epoch) this.receive(event) },
        () => { if (epoch === this.epoch) this.failed('Voice helper disconnected. Retry setup to recover.') })
      this.adapter = adapter
      const initialized = await adapter.initialize()
      if (epoch !== this.epoch) return this.snapshot()
      const availability = prompt ? await adapter.requestPermissions() : initialized
      if (epoch !== this.epoch) return this.snapshot()
      this.pendingSetup = false
      this.state.availability = availability
      const problem = this.availabilityProblem(availability)
      return this.reset(problem ? 'error' : 'ready', problem || 'Ready — microphone released. Click Start to check levels and transcribe.')
    } catch {
      if (epoch !== this.epoch) return this.snapshot()
      this.failed('Voice helper could not initialize. Prepare the bundled helper, then retry setup. Typed chat remains available.')
      return this.snapshot()
    }
  }
  private availabilityProblem(availability: VoiceAvailability): string | null {
    if (availability.microphone !== 'authorized' || availability.speech !== 'authorized') return recovery.permission
    if (!availability.onDevice || !availability.available) return recovery.unavailable
    if (!availability.devices.length || (this.state.settings.microphoneId &&
        !availability.devices.some((device) => device.id === this.state.settings.microphoneId))) return recovery.device
    return null
  }
  private allowed(): void {
    if (this.closed || this.suspended || !this.state.settings.enabled) throw new AppProblem('voice_disabled', 'Enable voice and unlock this Mac before recording.')
  }
  setShortcut(shortcut: VoiceShortcutState): VoiceState {
    this.state.shortcut = shortcut
    return this.publish()
  }
  holdPressed(id: string): void {
    if (this.hold || this.state.sessionId) return
    this.state.activation = 'hold'
    this.hold = { id, began: performance.now() }
    try { this.start('hold') }
    catch (error) {
      this.hold = undefined
      this.state.notice = publicProblem(error).message
      this.publish()
    }
  }
  holdReleased(id: string, cancelled = false, reason = ''): void {
    if (this.hold?.id !== id || !this.state.sessionId) return
    const sessionId = this.state.sessionId
    if (cancelled && reason === 'watchdog') {
      this.failed('45-second hold limit reached. Edit the draft; release every shortcut key before trying again.')
    } else if (cancelled || performance.now() - this.hold.began < 320 || this.state.input === 'starting') {
      this.cancel(sessionId)
    } else this.finish(sessionId)
  }
  invalidateHold(notice: string): void {
    if (this.state.activation === 'hold' && this.state.sessionId) this.failed(notice)
  }
  start(activation: 'manual' | 'hold' = 'manual'): VoiceState {
    this.allowed()
    if (this.pendingSetup || this.state.sessionId || this.closing) throw new AppProblem('busy', 'Finish or cancel the current recording first.')
    if (!this.adapter || !this.state.availability || this.availabilityProblem(this.state.availability))
      throw new AppProblem('voice_setup', 'Use Set up / Retry permissions before recording.')
    const sessionId = randomUUID()
    this.target = this.pinned ? this.state.conversationId ?? undefined :
      this.chatOpen && this.context.view === 'chat' ? this.context.conversationId ?? undefined : undefined
    const conversation = this.target ? this.dispatch?.conversation(this.target) : undefined
    this.dispatch?.reserve(sessionId)
    this.reservation = sessionId
    this.state.conversationId = this.target ?? null
    this.state.conversationTitle = conversation?.title ?? 'New voice conversation'
    this.state = { ...this.state, input: 'starting', activation, sessionId, provisional: '', level: 0, notice: 'Starting microphone…' }
    this.timer = setTimeout(() => this.failed(recovery.timeout), this.deadlines.start)
    this.publish()
    try { this.adapter.start(sessionId, this.state.settings.microphoneId) }
    catch { this.failed(recovery.audio) }
    return this.snapshot()
  }
  finish(sessionId: string): VoiceState {
    if (sessionId !== this.state.sessionId) throw new AppProblem('stale_voice', 'This recording has ended.')
    if (this.state.input === 'finalizing') return this.snapshot()
    if (this.state.input === 'starting') return this.cancel(sessionId)
    if (this.state.input !== 'listening') return this.snapshot()
    this.clearTimer()
    this.state.input = 'finalizing'; this.state.level = 0; this.state.notice = 'Microphone closing — finalizing text…'
    this.timer = setTimeout(() => this.failed(recovery.timeout), this.deadlines.finish)
    this.publish()
    try { this.adapter!.finish(sessionId) } catch { this.failed(recovery.recognition) }
    return this.snapshot()
  }
  cancel(sessionId: string): VoiceState {
    if (sessionId !== this.state.sessionId) return this.snapshot()
    // Dispose the generation too, so a late native start cannot reopen the microphone.
    this.dropAdapter()
    this.state.availability = null
    return this.reset('ready', 'Recording cancelled. Microphone released. Retry setup before recording again.')
  }
  stop(): VoiceState {
    this.state.activation = undefined
    if (this.state.sessionId) this.cancel(this.state.sessionId)
    else this.publish()
    this.dispatch?.stop()
    return this.snapshot()
  }
  private failed(notice: string): void {
    this.dropAdapter()
    this.state.availability = null
    this.reset('error', notice, true)
  }
  private receive(event: SpeechEvent): void {
    if (event.type === 'availability') {
      this.state.availability = event.availability
      const problem = this.availabilityProblem(event.availability)
      if (problem && this.state.sessionId) { this.failed(problem); return }
      this.publish(); return
    }
    if (event.type === 'failed' && !event.sessionId) { this.failed(recovery[event.reason]); return }
    if (!('sessionId' in event) || event.sessionId !== this.state.sessionId) return
    if (event.type === 'started') {
      if (this.state.input !== 'starting') return
      this.clearTimer()
      this.state.input = 'listening'; this.state.notice = this.state.activation === 'hold' ? 'Listening — release to send.' : 'Listening — click Finish to send, or Cancel.'
      this.timer = setTimeout(() => this.failed('45-second recording limit reached. Edit the draft or start a fresh recording.'), Math.max(1, this.deadlines.capture - (this.hold ? performance.now() - this.hold.began : 0)))
    } else if (event.type === 'partial') {
      if (!['listening', 'finalizing'].includes(this.state.input)) return
      this.state.provisional = event.text
      if (event.text.length > 4000) { this.failed('Speech exceeds 4,000 characters. Edit the draft; nothing was submitted.'); return }
    } else if (event.type === 'level') {
      if (this.state.input !== 'listening') return
      this.state.level = event.level
    } else if (event.type === 'final') {
      // A final while held is never accepted; silence alone cannot finish a turn.
      if (this.state.input !== 'finalizing') { this.failed('Recognition ended before Finish. Edit the draft or retry.'); return }
      const text = event.text.trim()
      if (text && text.length <= 4000 && this.dispatch) {
        this.acceptFinal(event.sessionId, text)
        return
      }
      if (text.length > 4000) this.state.draft = event.text
      else if (text) this.state.draft = text
      const notice = !text ? 'I didn’t catch that. Start a fresh recording.' : text.length > 4000 ?
        'Speech exceeds 4,000 characters. Edit the draft; nothing was submitted.' : 'Final transcript — editable, never submitted. Microphone released.'
      this.reset(text.length > 4000 ? 'error' : 'ready', notice)
      return
    } else if (event.type === 'failed') { this.failed(recovery[event.reason]); return }
    else if (event.type === 'stopped') { this.failed('Recording stopped unexpectedly. Edit the draft or retry.'); return }
    this.publish()
  }
  private acceptFinal(sessionId: string, text: string): void {
    // Invalidate before any callbacks/publications. A repeated native final cannot
    // reuse either the capture or its one-shot assistant reservation.
    this.clearTimer()
    this.state.sessionId = null
    this.state.provisional = ''; this.state.level = 0
    try {
      const control = voiceControl(text)
      if (control === 'stop') {
        this.dispatch!.stop()
        this.reset('ready', 'Stop requested. No later reply will be added. Already-submitted external actions cannot be undone.')
      } else if (control === 'disable') {
        this.save({ ...this.state.settings, enabled: false })
      } else if (control === 'stop-speaking') {
        this.reset('ready', 'Spoken replies are not available yet. The assistant task continues.')
      } else if (needsVoiceScreen(text)) {
        this.state.draft = text
        this.reset('ready', 'Voice screen requests are not available yet. Use typed chat and Capture screen; clarify ambiguous visual references there. No screenshot was taken.')
      } else {
        const receipt = this.dispatch!.submit(sessionId, text, this.target)
        this.pinned = true
        this.state.conversationId = receipt.conversationId
        this.state.conversationTitle = this.dispatch!.conversation(receipt.conversationId).title
        this.state.receipt = receipt
        this.state.draft = ''
        this.reset('ready', 'Request sent. Microphone released. Start a new recording to follow up or say Stop.')
      }
    } catch (error) {
      this.state.draft = text
      this.reset('ready', publicProblem(error).message + ' Nothing was queued; edit the draft or start a fresh recording.')
    }
  }
  suspend(): void {
    this.suspended = true
    this.dropAdapter(); this.state.availability = null
    this.reset('suspended', 'Voice suspended. Microphone released.', true)
  }
  resume(): void {
    if (!this.suspended || this.closed) return
    this.suspended = false
    this.reset(this.state.settings.enabled ? 'ready' : 'disabled', 'Microphone released. Retry setup and start a fresh recording.')
  }
  dispose(): Promise<void> {
    this.closed = true
    this.dropAdapter(); this.state.availability = null
    this.reset('disabled', 'Voice closed.')
    return this.closing ?? Promise.resolve()
  }
}
