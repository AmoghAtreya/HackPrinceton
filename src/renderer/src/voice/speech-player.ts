import type { SpeechBridge } from '../../../shared/speech-contracts'

export type PlaybackState = 'idle' | 'loading' | 'speaking'

export interface PlaybackSnapshot {
  state: PlaybackState
  /** What is being (or was last) spoken. */
  text: string | null
  /** Whether "Say that again" has something to replay. */
  canReplay: boolean
  /** Set once when Polly fails and the Mac's built-in voice takes over. */
  notice?: string
}

/**
 * Plays spoken replies: Amazon Polly audio (via the main process) through Web
 * Audio, falling back to the system voice (speechSynthesis) so Triage never
 * goes silent. One reply plays at a time; anything new stops the old one.
 */
export class SpeechPlayer {
  private readonly bridge: () => SpeechBridge | undefined
  private context?: AudioContext
  private source?: AudioBufferSourceNode
  private generation = 0
  private lastText: string | null = null
  private lastBuffer: AudioBuffer | null = null
  private snapshotValue: PlaybackSnapshot = { state: 'idle', text: null, canReplay: false }
  private listeners = new Set<(snapshot: PlaybackSnapshot) => void>()
  private noticeShown = false

  constructor(bridge: () => SpeechBridge | undefined) {
    this.bridge = bridge
  }

  snapshot(): PlaybackSnapshot { return { ...this.snapshotValue } }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => { this.listeners.delete(listener) }
  }

  /** Speaks `text` (already shortened with prepareSpeech). Resolves when playback starts or fails. */
  async speak(text: string): Promise<void> {
    const spoken = text.trim()
    if (!spoken) return
    this.stopPlayback()
    const mine = ++this.generation
    this.lastText = spoken
    this.lastBuffer = null
    this.update({ state: 'loading', text: spoken, canReplay: true })
    let fallbackReason: string | undefined
    try {
      const bridge = this.bridge()
      if (!bridge) throw new Error('Speech is unavailable in this window.')
      const result = await bridge.synthesizeSpeech(spoken)
      if (!result.ok) throw new Error(result.error.message)
      const context = await this.audioContext()
      const bytes = result.value.audio
      const buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      if (mine !== this.generation) return
      this.lastBuffer = buffer
      this.playBuffer(buffer, mine)
      return
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : 'Amazon Polly is unavailable.'
    }
    if (mine !== this.generation) return
    await this.speakWithSystemVoice(spoken, mine)
    if (!this.noticeShown && fallbackReason) {
      this.noticeShown = true
      this.update({ notice: `Using this Mac's built-in voice because Amazon Polly isn't available: ${fallbackReason}` })
    }
  }

  /** Plays the last reply again, without calling Polly again when audio is cached. */
  async replay(): Promise<void> {
    if (!this.lastText) return
    if (!this.lastBuffer) return this.speak(this.lastText)
    this.stopPlayback()
    const mine = ++this.generation
    this.playBuffer(this.lastBuffer, mine)
  }

  stop(): void {
    this.generation++
    this.stopPlayback()
    if (this.snapshotValue.state !== 'idle') this.update({ state: 'idle' })
  }

  dismissNotice(): void {
    if (this.snapshotValue.notice) this.update({ notice: undefined })
  }

  private playBuffer(buffer: AudioBuffer, mine: number): void {
    const context = this.context!
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      if (this.source === source) this.source = undefined
      if (mine === this.generation) this.update({ state: 'idle' })
    }
    this.source = source
    source.start()
    this.update({ state: 'speaking', text: this.lastText, canReplay: true })
  }

  private async speakWithSystemVoice(text: string, mine: number): Promise<void> {
    if (!('speechSynthesis' in window)) { this.update({ state: 'idle' }); return }
    let rate = 0.9
    try {
      const result = await this.bridge()?.getSpeechSettings()
      if (result?.ok) rate = result.value.rate / 100
    } catch { /* Keep the relaxed default. */ }
    if (mine !== this.generation) return
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    utterance.rate = rate
    utterance.onend = utterance.onerror = () => { if (mine === this.generation) this.update({ state: 'idle' }) }
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
    this.update({ state: 'speaking', text, canReplay: true })
  }

  private async audioContext(): Promise<AudioContext> {
    if (!this.context || this.context.state === 'closed') this.context = new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()
    return this.context
  }

  private stopPlayback(): void {
    const source = this.source
    this.source = undefined
    if (source) {
      source.onended = null
      try { source.stop() } catch { /* Already stopped. */ }
      source.disconnect()
    }
    if ('speechSynthesis' in window && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) window.speechSynthesis.cancel()
  }

  private update(patch: Partial<PlaybackSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch }
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch { /* A broken listener must not stop playback. */ }
    }
  }
}

/** The chat window's single player, shared by the panel, the talk button and settings. */
export const speechPlayer = new SpeechPlayer(() => (typeof window !== 'undefined' ? window.triage : undefined))
