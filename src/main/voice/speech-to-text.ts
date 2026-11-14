/**
 * Anything that turns streamed 16-bit PCM audio into live text: Amazon
 * Transcribe (cloud, paid) or Apple's on-device recognizer (free, offline).
 * The voice controller, captions and chatbot hookup work the same with either.
 */
export interface SpeechToTextResult {
  segmentId: string
  text: string
  isFinal: boolean
  /** Mean word confidence (0–1) for final results; null when unknown. */
  confidence: number | null
  startTime: number
  endTime: number
}

export interface SpeechToTextService {
  readonly config: { languageCode: string }
  /** Short label for logs and docs, e.g. "Amazon Transcribe". */
  readonly name: string
  readonly id: 'apple' | 'transcribe'
  /** Fails fast with a readable AppProblem when this backend cannot run. */
  verify(): Promise<void>
  /** Streams audio until it ends, reporting partial and final results. */
  stream(audio: AsyncIterable<Uint8Array>, sampleRate: number, signal: AbortSignal,
    onResult: (result: SpeechToTextResult) => void): Promise<void>
  dispose(): void
}
