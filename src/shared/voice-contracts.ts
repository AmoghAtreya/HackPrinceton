import type { Result } from './assistant-contracts'

/**
 * Voice layer contract (Amazon Transcribe streaming).
 *
 * Audio is captured in the chat renderer as 16-bit little-endian PCM, mono,
 * 16 kHz, and streamed to the main process, which owns the AWS credentials and
 * the Transcribe connection. The renderer never sees AWS credentials.
 */

export const VOICE_SAMPLE_RATE = 16000
/** Longest single recording; the session finishes itself after this. Generous, because older speakers pause a lot. */
export const VOICE_MAX_SECONDS = 90
/** Upper bound for one audio chunk sent over IPC (about 1 s of audio). */
export const VOICE_MAX_CHUNK_BYTES = 32000

/** "speaking" is reserved for text-to-speech (Amazon Polly), which is not built yet. */
export type SpeechState = 'idle' | 'listening' | 'thinking' | 'speaking'

/** Voice → UI: what the voice layer is doing right now. */
export interface SpeechStateMessage {
  type: 'speech_state'
  state: SpeechState
  sessionId: string | null
  error?: string
}

/**
 * Voice → agent/UI: one Transcribe result. Partial results for the same
 * segmentId are replaced by later ones; a result with isFinal true is settled.
 */
export interface UserUtterance {
  type: 'user_utterance'
  sessionId: string
  segmentId: string
  text: string
  isFinal: boolean
  /** Mean word confidence from Transcribe (0–1); null for partials or when unavailable. */
  confidence: number | null
  timestamp: number
}

export interface TranscriptSegment {
  id: string
  text: string
  confidence: number | null
  /** Seconds from the start of the recording, as reported by Transcribe. */
  startTime: number
  endTime: number
}

/** One finished recording, as stored. */
export interface TranscriptRecord {
  id: string
  startedAt: number
  endedAt: number
  languageCode: string
  status: 'completed' | 'failed'
  /** All final segments joined in order. Empty when nothing was heard. */
  text: string
  segments: TranscriptSegment[]
  error?: string
  /** Which engine produced `text`: the live-caption engine, or Gemini when it refined the recording. */
  transcribedBy?: 'apple' | 'transcribe' | 'gemini'
  /** What the live-caption engine heard, kept when Gemini wrote the final text. */
  captionText?: string
}

export interface VoiceStartReceipt { sessionId: string; sampleRate: number; maxSeconds: number }

export interface VoiceBridge {
  startVoice(): Promise<Result<VoiceStartReceipt>>
  /** Fire-and-forget: one chunk of 16-bit PCM for the active session. */
  sendVoiceAudio(sessionId: string, chunk: ArrayBuffer): void
  finishVoice(sessionId: string): Promise<Result<TranscriptRecord>>
  cancelVoice(sessionId: string): Promise<Result<void>>
  listTranscripts(): Promise<Result<TranscriptRecord[]>>
  onSpeechState(listener: (message: SpeechStateMessage) => void): () => void
  onUtterance(listener: (utterance: UserUtterance) => void): () => void
}

export const voiceChannels = {
  start: 'voice:start',
  audio: 'voice:audio',
  finish: 'voice:finish',
  cancel: 'voice:cancel',
  list: 'voice:list',
  state: 'voice:state',
  utterance: 'voice:utterance'
} as const
