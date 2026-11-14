import { randomUUID } from 'node:crypto'
import {
  VOICE_MAX_CHUNK_BYTES, VOICE_MAX_SECONDS, VOICE_SAMPLE_RATE,
  type SpeechState, type SpeechStateMessage, type TranscriptRecord, type TranscriptSegment,
  type UserUtterance, type VoiceStartReceipt
} from '../../shared/voice-contracts.ts'
import { AppProblem, publicProblem } from '../assistant/errors.ts'
import { AudioQueue } from './audio-queue.ts'
import type { SpeechToTextResult, SpeechToTextService } from './speech-to-text.ts'
import type { TranscriptStore } from './transcript-store.ts'

/** Everything the voice layer publishes. The agent layer subscribes to `transcript`. */
export type VoiceEvent = SpeechStateMessage | UserUtterance | { type: 'transcript'; record: TranscriptRecord }

interface ActiveSession {
  id: string
  startedAt: number
  queue: AudioQueue
  abort: AbortController
  segments: Map<string, TranscriptSegment>
  stream: Promise<void>
  error?: AppProblem
  limit: ReturnType<typeof setTimeout>
  finishing?: Promise<TranscriptRecord>
  cancelled?: boolean
  /** The whole recording, kept in memory only so a final transcriber can read it. */
  recording: Uint8Array[]
  recordedBytes: number
  /** Cancels the final transcriber if the recording is cancelled meanwhile. */
  finalAbort: AbortController
}

/** A second engine that rewrites the whole recording once it ends (Gemini); null keeps the live transcript. */
export type FinalTranscriber = (recording: readonly Uint8Array[], sampleRate: number, signal: AbortSignal) =>
  Promise<{ text: string; clarity: 'clear' | 'unclear' } | null>

export interface VoiceControllerOptions {
  service: SpeechToTextService
  store: TranscriptStore
  /** Resolves when the OS allows microphone use; throws an AppProblem otherwise. */
  ensureMicrophone: () => Promise<void>
  finishTimeoutMs?: number
  /**
   * Optional: transcribes the finished recording (Gemini) and replaces the
   * live-caption text. Returning null, or failing, keeps the live text.
   */
  finalTranscriber?: FinalTranscriber
}

/**
 * Owns at most one recording at a time: renderer audio → Transcribe →
 * live utterances → a stored TranscriptRecord.
 */
export class VoiceController {
  private session: ActiveSession | null = null
  private starting = false
  private disposed = false
  private state: SpeechState = 'idle'
  private listeners = new Set<(event: VoiceEvent) => void>()
  /** Finished sessions, so a late or repeated finish() gets the same answer. */
  private finished = new Map<string, Promise<TranscriptRecord>>()

  private readonly options: VoiceControllerOptions

  constructor(options: VoiceControllerOptions) {
    this.options = options
  }

  subscribe(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot(): SpeechStateMessage {
    return { type: 'speech_state', state: this.state, sessionId: this.session?.id ?? null }
  }

  async start(): Promise<VoiceStartReceipt> {
    if (this.disposed) throw new AppProblem('closed', 'Triage is closing.')
    if (this.session || this.starting) throw new AppProblem('busy', 'Already listening. Finish the current recording first.')
    this.starting = true
    try {
      await this.options.ensureMicrophone()
      await this.options.service.verify()
      if (this.disposed) throw new AppProblem('closed', 'Triage is closing.')
    } finally {
      this.starting = false
    }

    const queue = new AudioQueue()
    const abort = new AbortController()
    const session: ActiveSession = {
      id: randomUUID(), startedAt: Date.now(), queue, abort, segments: new Map(),
      stream: Promise.resolve(), recording: [], recordedBytes: 0, finalAbort: new AbortController(),
      limit: setTimeout(() => { void this.finish(session.id).catch(() => undefined) }, VOICE_MAX_SECONDS * 1000)
    }
    session.stream = this.options.service.stream(queue, VOICE_SAMPLE_RATE, abort.signal, (result) => this.receive(session, result))
      .catch((error: unknown) => {
        // Cancellation and finish timeouts abort on purpose; that is not an error.
        if (abort.signal.aborted) return
        session.error = error instanceof AppProblem ? error : new AppProblem('aws_unavailable', publicProblem(error).message)
        // A failure while still recording ends the session; the renderer stops its microphone on idle.
        if (!session.finishing) void this.finish(session.id).catch(() => undefined)
      })
    this.session = session
    this.setState('listening')
    return { sessionId: session.id, sampleRate: VOICE_SAMPLE_RATE, maxSeconds: VOICE_MAX_SECONDS }
  }

  pushAudio(sessionId: string, chunk: Uint8Array): void {
    const session = this.session
    if (!session || session.id !== sessionId || session.finishing) return
    if (chunk.byteLength === 0 || chunk.byteLength > VOICE_MAX_CHUNK_BYTES || chunk.byteLength % 2 !== 0) return
    session.queue.push(chunk)
    if (this.options.finalTranscriber && session.recordedBytes + chunk.byteLength <= VOICE_SAMPLE_RATE * 2 * (VOICE_MAX_SECONDS + 1)) {
      session.recording.push(chunk.slice())
      session.recordedBytes += chunk.byteLength
    }
  }

  finish(sessionId: string): Promise<TranscriptRecord> {
    const previous = this.finished.get(sessionId)
    if (previous) return previous
    const session = this.session
    if (!session || session.id !== sessionId) return Promise.reject(new AppProblem('voice_ended', 'This recording has already ended.'))
    session.finishing ??= this.complete(session)
    return session.finishing
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.session
    if (!session || session.id !== sessionId) return
    this.teardown(session)
    this.setState('idle')
  }

  /** Drop any recording, e.g. when the Mac sleeps or locks. Nothing is stored. */
  interrupt(): void {
    const session = this.session
    if (!session) return
    this.teardown(session)
    this.setState('idle', 'Recording stopped because this Mac went to sleep or was locked.')
  }

  recent(limit = 20): Promise<TranscriptRecord[]> {
    return this.options.store.recent(Math.max(1, Math.min(limit, 100)))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.session) this.teardown(this.session)
    this.listeners.clear()
    this.options.service.dispose()
  }

  private async complete(session: ActiveSession): Promise<TranscriptRecord> {
    clearTimeout(session.limit)
    session.queue.end()
    if (!session.error) this.setState('thinking')
    // Transcribe sends its last final result shortly after the audio stream closes.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), this.options.finishTimeoutMs ?? 10000) })
    const outcome = await Promise.race([session.stream.then(() => 'done' as const), timedOut])
    clearTimeout(timer)
    if (outcome === 'timeout') session.abort.abort()

    const segments = [...session.segments.values()].sort((a, b) => a.startTime - b.startTime)
    const liveText = segments.map((segment) => segment.text).filter(Boolean).join(' ')
    let record: TranscriptRecord = {
      id: session.id,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      languageCode: this.options.service.config.languageCode,
      status: session.error ? 'failed' : 'completed',
      text: liveText,
      segments,
      transcribedBy: this.options.service.id,
      ...(session.error ? { error: session.error.message } : {})
    }
    // Live captions came from the on-device engine; the final words come from Gemini when it can.
    // It also rescues a recording whose live engine failed.
    if (this.options.finalTranscriber && session.recording.length && !session.cancelled) {
      let refined: Awaited<ReturnType<FinalTranscriber>> = null
      try { refined = await this.options.finalTranscriber(session.recording, VOICE_SAMPLE_RATE, session.finalAbort.signal) }
      catch { refined = null }
      session.recording = []
      if (refined?.text && !session.cancelled) {
        record = {
          ...record,
          status: 'completed',
          text: refined.text,
          segments: [{ id: 'gemini', text: refined.text, confidence: refined.clarity === 'clear' ? 0.95 : 0.5, startTime: 0, endTime: (Date.now() - session.startedAt) / 1000 }],
          transcribedBy: 'gemini',
          ...(liveText ? { captionText: liveText } : {}),
          endedAt: Date.now()
        }
        delete record.error
      }
    }
    const result = this.store(session, record)
    this.finished.set(session.id, result)
    while (this.finished.size > 5) this.finished.delete(this.finished.keys().next().value!)
    return result
  }

  private async store(session: ActiveSession, record: TranscriptRecord): Promise<TranscriptRecord> {
    if (session.cancelled) return record
    try {
      if (record.text) await this.options.store.save(record)
    } catch {
      console.warn('A voice transcript could not be saved.')
    } finally {
      if (this.session === session) this.session = null
    }
    if (record.status === 'failed' && !record.text) {
      this.setState('idle', record.error)
      throw session.error
    }
    this.emit({ type: 'transcript', record })
    this.setState('idle', record.error)
    return record
  }

  private receive(session: ActiveSession, result: SpeechToTextResult): void {
    if (this.session !== session) return
    if (result.isFinal) {
      if (result.text) {
        session.segments.set(result.segmentId, {
          id: result.segmentId, text: result.text, confidence: result.confidence,
          startTime: result.startTime, endTime: result.endTime
        })
      } else session.segments.delete(result.segmentId)
    }
    this.emit({
      type: 'user_utterance', sessionId: session.id, segmentId: result.segmentId, text: result.text,
      isFinal: result.isFinal, confidence: result.confidence, timestamp: Date.now()
    })
  }

  private teardown(session: ActiveSession): void {
    session.cancelled = true
    session.finalAbort.abort()
    session.recording = []
    clearTimeout(session.limit)
    session.abort.abort()
    session.queue.end()
    if (this.session === session) this.session = null
  }

  private setState(state: SpeechState, error?: string): void {
    this.state = state
    this.emit({ type: 'speech_state', state, sessionId: this.session?.id ?? null, ...(error ? { error } : {}) })
  }

  private emit(event: VoiceEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { console.warn('A voice listener failed.') }
    }
  }
}
