import { z } from 'zod'
import { destinations } from '../../shared/destinations.ts'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
/** Google's alias for the current Flash model, so retired versions never break voice. */
export const GEMINI_TRANSCRIBE_MODEL = 'gemini-flash-latest'
/** Lighter, faster Flash model tried when the main one is busy or slow. */
export const GEMINI_TRANSCRIBE_FALLBACK_MODEL = 'gemini-flash-lite-latest'
/** Gemini must answer within this time overall, or Triage keeps Apple's transcript. */
export const GEMINI_TRANSCRIBE_TIMEOUT_MS = 8000
/** Time the main model gets before Triage tries the lighter one. */
export const GEMINI_TRANSCRIBE_FIRST_ATTEMPT_MS = 5000
/** Writing down a short request needs no reasoning; skipping Gemini's thinking step makes it much faster. */
const NO_THINKING = { thinkingBudget: 0 } as const

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
  private readonly models: string[]
  private readonly timeoutMs: number
  private readonly firstAttemptMs: number
  /** Models that rejected NO_THINKING; they are asked again without it. */
  private readonly thinkingRefused = new Set<string>()

  constructor(options: { fetcher?: typeof globalThis.fetch; model?: string; fallbackModel?: string | null; timeoutMs?: number; firstAttemptMs?: number } = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch
    const model = options.model ?? process.env.TRIAGE_GEMINI_TRANSCRIBE_MODEL ?? GEMINI_TRANSCRIBE_MODEL
    const fallback = options.fallbackModel === undefined ? GEMINI_TRANSCRIBE_FALLBACK_MODEL : options.fallbackModel
    this.models = fallback && fallback !== model ? [model, fallback] : [model]
    this.timeoutMs = options.timeoutMs ?? GEMINI_TRANSCRIBE_TIMEOUT_MS
    this.firstAttemptMs = options.firstAttemptMs ?? GEMINI_TRANSCRIBE_FIRST_ATTEMPT_MS
  }

  /**
   * Tries the main model, then (if it was busy, slow or missing) the lighter
   * one, all within the overall time limit. Returns null to keep the on-device
   * transcript: a bad key, no network, or nothing usable in time.
   */
  async transcribe(key: string, chunks: readonly Uint8Array[], sampleRate: number, signal: AbortSignal): Promise<GeminiTranscript | null> {
    if (!chunks.length) return null
    const audio = pcmToWav(chunks, sampleRate).toString('base64')
    const deadline = Date.now() + this.timeoutMs
    for (let index = 0; index < this.models.length;) {
      const model = this.models[index]
      const remaining = deadline - Date.now()
      if (remaining < 750 || signal.aborted) break
      const budget = index === 0 && this.models.length > 1 ? Math.min(remaining, this.firstAttemptMs) : remaining
      const started = Date.now()
      const outcome = await this.attempt(key, model, audio, signal, budget)
      if (outcome.kind === 'ok') {
        console.info(`Gemini ${model} transcribed in ${Date.now() - started} ms.`)
        return outcome.transcript
      }
      if (outcome.kind === 'stop') return null
      if (outcome.kind === 'again') continue
      if (index < this.models.length - 1) console.warn(`Gemini ${model} was ${outcome.reason}; trying ${this.models[index + 1]}.`)
      index++
    }
    if (!signal.aborted) console.warn('Gemini transcription unavailable in time; using the on-device transcript.')
    return null
  }

  private async attempt(key: string, model: string, audio: string, signal: AbortSignal, budgetMs: number):
    Promise<{ kind: 'ok'; transcript: GeminiTranscript } | { kind: 'retry'; reason: string } | { kind: 'again' } | { kind: 'stop' }> {
    const timer = AbortSignal.timeout(budgetMs)
    try {
      const response = await this.fetcher(`${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        // The key goes in a header, never in the URL.
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/wav', data: audio } }, { text: PROMPT }] }],
          generationConfig: {
            responseMimeType: 'application/json', maxOutputTokens: 1024, temperature: 0,
            ...(this.thinkingRefused.has(model) ? {} : { thinkingConfig: NO_THINKING })
          }
        }),
        signal: AbortSignal.any([signal, timer])
      })
      if (!response.ok) {
        // A model that cannot skip thinking: ask the same model again without that setting.
        if (response.status === 400 && !this.thinkingRefused.has(model) && /thinking/i.test(await response.text().catch(() => ''))) {
          this.thinkingRefused.add(model)
          return { kind: 'again' }
        }
        // Busy, rate-limited, retired or failing: worth trying the other model. A rejected key is not.
        if ([404, 408, 429].includes(response.status) || response.status >= 500) return { kind: 'retry', reason: `unavailable (HTTP ${response.status})` }
        console.warn(`Gemini transcription refused (HTTP ${response.status}); using the on-device transcript.`)
        return { kind: 'stop' }
      }
      const parsed = responseSchema.safeParse(await response.json())
      const text = parsed.success ? (parsed.data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim() : ''
      let answer
      try { answer = answerSchema.safeParse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))) }
      catch { return { kind: 'retry', reason: 'unreadable' } }
      if (!answer.success) return { kind: 'retry', reason: 'unreadable' }
      return { kind: 'ok', transcript: { text: answer.data.text.trim(), clarity: answer.data.clarity ?? 'clear' } }
    } catch {
      if (signal.aborted) return { kind: 'stop' }
      return { kind: 'retry', reason: timer.aborted ? 'too slow' : 'unreachable' }
    }
  }
}
