import { z } from 'zod'
import { destinations } from '../../shared/destinations.ts'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const GEMINI_TRANSCRIBE_MODEL = 'gemini-2.5-flash'
/** Gemini must answer within this time, or Triage keeps Apple's transcript. */
export const GEMINI_TRANSCRIBE_TIMEOUT_MS = 6000

export interface GeminiTranscript {
  text: string
  /** Gemini's own judgement of how clearly it heard the request. */
  clarity: 'clear' | 'unclear'
}

/** Builds a WAV file around 16-bit mono PCM so Gemini can read it as audio/wav. */
export function pcmToWav(chunks: readonly Uint8Array[], sampleRate: number): Buffer {
  const dataLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)          // PCM chunk size
  header.writeUInt16LE(1, 20)           // PCM format
  header.writeUInt16LE(1, 22)           // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)           // block align
  header.writeUInt16LE(16, 34)          // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataLength, 40)
  return Buffer.concat([header, ...chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))])
}

/** Words Triage often hears, so Gemini favours them over sound-alikes. */
export function transcriptionHints(): string {
  const names = destinations.map((destination) => destination.name.replace(/^(your|my|the) /i, ''))
  return [...new Set([...names, 'Triage', 'show me where', 'is this safe', 'simplify this', 'start over', 'stop'])].join(', ')
}

const PROMPT = `This audio is an older adult speaking a short request to Triage, a voice helper on their computer.
Write down exactly what they said, in plain text with normal punctuation. Do not answer the request or add anything.
Remove filler sounds like "um". If there is no speech, use an empty string.
Words they may use: ${transcriptionHints()}.
Return ONLY JSON: {"text":"…","clarity":"clear"|"unclear"}. Use "unclear" if any part was hard to make out.`

const answerSchema = z.object({ text: z.string().max(4000), clarity: z.enum(['clear', 'unclear']).optional() }).passthrough()

const responseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({ parts: z.array(z.object({ text: z.string().optional() }).passthrough()).optional() }).passthrough().optional()
  }).passthrough()).optional()
}).passthrough()

/**
 * Sends one finished recording to Gemini for an accurate transcript.
 * Returns null on any problem (no network, bad key, rate limit, timeout,
 * unreadable answer), so the caller keeps the on-device transcript.
 */
export class GeminiTranscriber {
  private readonly fetcher: typeof globalThis.fetch
  private readonly model: string
  private readonly timeoutMs: number

  constructor(options: { fetcher?: typeof globalThis.fetch; model?: string; timeoutMs?: number } = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch
    this.model = options.model ?? process.env.TRIAGE_GEMINI_TRANSCRIBE_MODEL ?? GEMINI_TRANSCRIBE_MODEL
    this.timeoutMs = options.timeoutMs ?? GEMINI_TRANSCRIBE_TIMEOUT_MS
  }

  async transcribe(key: string, chunks: readonly Uint8Array[], sampleRate: number, signal: AbortSignal): Promise<GeminiTranscript | null> {
    if (!chunks.length) return null
    const wav = pcmToWav(chunks, sampleRate)
    try {
      const response = await this.fetcher(`${BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        // The key goes in a header, never in the URL.
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } }, { text: PROMPT }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024, temperature: 0 }
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      })
      if (!response.ok) {
        console.warn(`Gemini transcription unavailable (HTTP ${response.status}); using the on-device transcript.`)
        return null
      }
      const parsed = responseSchema.safeParse(await response.json())
      const text = parsed.success ? (parsed.data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim() : ''
      const answer = answerSchema.safeParse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')))
      if (!answer.success) return null
      return { text: answer.data.text.trim(), clarity: answer.data.clarity ?? 'clear' }
    } catch {
      if (!signal.aborted) console.warn('Gemini transcription failed or timed out; using the on-device transcript.')
      return null
    }
  }
}
