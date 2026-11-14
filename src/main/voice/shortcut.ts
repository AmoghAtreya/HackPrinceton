import type { VoiceSettings, VoiceShortcutState, VoiceState } from '../../shared/voice-contracts.ts'
import type { SpeechAdapter, SpeechEvent } from './adapter.ts'
import type { VoiceSession } from './session.ts'
import { voiceSettingsSchema } from './settings.ts'
import { AppProblem } from '../assistant/errors.ts'

export interface ShortcutAdapter extends SpeechAdapter {
  registerShortcut(chord: string, prompt: boolean): Promise<VoiceShortcutState>
}
type Factory = (event: (event: SpeechEvent) => void, lost: () => void) => ShortcutAdapter

/** Separate helper lifetime: cancelling audio never removes the release watcher. */
export class VoiceShortcut {
  private adapter?: ShortcutAdapter
  private epoch = 0
  private closing = new Set<Promise<void>>()
  private busy = false
  private intent = 0
  private recovering = false
  private suspended = false
  private closed = false
  private session: VoiceSession
  private factory: Factory
  constructor(session: VoiceSession, factory: Factory) { this.session = session; this.factory = factory }

  observe(state: VoiceState): void {
    if (!state.settings.enabled) {
      this.stop()
      if (state.shortcut?.chord) this.session.setShortcut({ chord: null, status: 'unavailable', notice: 'Voice is off.' })
      return
    }
    // A cancelled generation is replaced without prompting or opening audio. A new
    // press must still arrive after the native watcher has seen every key released.
    if (!this.closed && !this.suspended && !this.recovering && !this.busy &&
        state.input === 'ready' && !state.availability && this.adapter) {
      this.recovering = true
      void Promise.resolve().then(() => this.session.setup(false)).catch(() => {}).finally(() => { this.recovering = false })
    }
  }
  private async register(chord: string, prompt: boolean): Promise<VoiceShortcutState> {
    if (this.closed || this.suspended) throw new AppProblem('voice_disabled', 'Unlock this Mac before setting up global talk.')
    if (!this.adapter) {
      const epoch = ++this.epoch
      this.adapter = this.factory((event) => {
        if (epoch !== this.epoch) return
        if (event.type === 'pressed') this.session.holdPressed(event.holdId)
        else if (event.type === 'released') this.session.holdReleased(event.holdId, event.cancelled, event.reason)
        else if (event.type === 'shortcut-invalidated') this.unavailable(event.notice)
      }, () => { if (epoch === this.epoch) this.unavailable('Global talk helper disconnected. Retry setup; click-to-talk remains available.') })
      await this.adapter.initialize()
      if (epoch !== this.epoch) throw new Error('stale shortcut setup')
    }
    const epoch = this.epoch
    const state = await this.adapter.registerShortcut(chord, prompt)
    if (epoch !== this.epoch) throw new AppProblem('voice_disabled', 'Global setup was interrupted. Retry setup.')
    return state
  }
  async save(settings: VoiceSettings): Promise<VoiceState> {
    const parsed = voiceSettingsSchema.parse(settings)
    if (!parsed.enabled) {
      this.intent++
      this.stop()
      return this.session.save(parsed)
    }
    if (this.busy) throw new AppProblem('busy', 'Wait for global shortcut setup to finish.')
    const intent = ++this.intent
    this.busy = true
    const previous = this.session.snapshot().settings
    const id = this.session.snapshot().sessionId
    if (id) this.session.cancel(id)
    try {
      const state = await this.register(parsed.shortcut, false)
      if (intent !== this.intent) throw new AppProblem('voice_disabled', 'Global setup was interrupted.')
      if (state.status === 'conflict') {
        this.session.setShortcut(state)
        throw new AppProblem('shortcut_conflict', state.notice)
      }
      try {
        // Publish the binding after enabling preferences, so the disabled-state
        // observer cannot dispose a newly validated helper during first setup.
        this.session.save(parsed)
        return this.session.setShortcut(state)
      }
      catch (error) {
        // Restore the actual old binding if durable preferences could not be saved.
        if (previous.enabled) this.session.setShortcut(await this.register(previous.shortcut, false))
        else this.stop()
        throw error
      }
    } catch (error) {
      if (intent !== this.intent || this.closed || this.suspended) throw new AppProblem('voice_disabled', 'Global setup was interrupted.')
      if (!(error instanceof AppProblem)) {
        this.unavailable('Global talk setup failed. Retry setup; click-to-talk remains available.')
        // Native failure must not remove the accessible manual fallback.
        return this.session.save(parsed)
      }
      throw error
    } finally { this.busy = false }
  }
  async setup(prompt = true): Promise<VoiceState> {
    if (this.busy) throw new AppProblem('busy', 'Wait for global shortcut setup to finish.')
    this.busy = true
    try {
      await this.session.setup(prompt)
      if (this.session.snapshot().settings.enabled && !this.suspended && !this.closed) {
        try { this.session.setShortcut(await this.register(this.session.snapshot().settings.shortcut, prompt)) }
        catch { this.unavailable('Global talk setup failed. Retry setup; click-to-talk remains available.') }
      }
      return this.session.snapshot()
    } finally { this.busy = false }
  }
  private unavailable(notice: string): void {
    this.session.invalidateHold(notice)
    this.stop()
    this.session.setShortcut({ status: 'unavailable', chord: null, notice })
  }
  private stop(): void {
    this.epoch++
    const adapter = this.adapter; this.adapter = undefined
    if (adapter) {
      const closing = Promise.resolve(adapter.dispose()).catch(() => {}).then(() => { this.closing.delete(closing) })
      this.closing.add(closing)
    }
  }
  suspend(): void {
    this.intent++
    this.suspended = true
    this.unavailable('Global talk suspended. Unlock and retry setup; a fresh press is required.')
  }
  resume(): void { this.suspended = false }
  async dispose(): Promise<void> { this.intent++; this.closed = true; this.stop(); await Promise.all(this.closing) }
}
