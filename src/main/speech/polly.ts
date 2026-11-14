import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly'
import { SPEECH_MAX_CHARS, type SpeechRate, type SpeechVoice } from '../../shared/speech-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { awsRegionFromEnv } from '../aws/config.ts'

const CACHE_SIZE = 20

type PollyEngine = 'neural' | 'standard'
/** Ruth and Stephen exist only as neural voices; the closest standard voices stand in for them. */
const STANDARD_STAND_IN: Partial<Record<SpeechVoice, SpeechVoice>> = { Ruth: 'Joanna', Stephen: 'Matthew' }

function engineUnsupported(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
  const message = error instanceof Error ? error.message : ''
  return name === 'EngineNotSupportedException' || (name === 'ValidationException' && /engine is not supported/i.test(message))
}

export function escapeSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Neural voices support <prosody rate>; slower speech is easier to follow for older listeners. */
export function buildSsml(text: string, rate: SpeechRate): string {
  return `<speak><prosody rate="${rate}%">${escapeSsml(text)}</prosody></speak>`
}

/** Amazon Polly text-to-speech, called only from the main process (which holds AWS credentials). */
export class PollyService {
  private client: Pick<PollyClient, 'send' | 'destroy'> | null
  private cache = new Map<string, Uint8Array>()
  readonly region: string
  /**
   * Neural voices sound best but are not offered in every region. After the
   * first "engine not supported" answer, standard voices are used instead.
   */
  private engine: PollyEngine

  constructor(region = awsRegionFromEnv(process.env, process.env.TRIAGE_POLLY_REGION),
    options: { client?: Pick<PollyClient, 'send' | 'destroy'>; engine?: PollyEngine } = {}) {
    this.region = region
    this.client = options.client ?? null
    this.engine = options.engine ?? (process.env.TRIAGE_POLLY_ENGINE === 'standard' ? 'standard' : 'neural')
  }

  get activeEngine(): PollyEngine { return this.engine }

  private getClient(): Pick<PollyClient, 'send' | 'destroy'> {
    this.client ??= new PollyClient({ region: this.region })
    return this.client
  }

  private async request(text: string, voice: SpeechVoice, rate: SpeechRate, engine: PollyEngine): Promise<Uint8Array | undefined> {
    const response = await this.getClient().send(new SynthesizeSpeechCommand({
      Engine: engine,
      OutputFormat: 'mp3',
      // Standard voices top out at 22.05 kHz for mp3.
      SampleRate: engine === 'neural' ? '24000' : '22050',
      TextType: 'ssml',
      Text: buildSsml(text, rate),
      VoiceId: engine === 'standard' ? STANDARD_STAND_IN[voice] ?? voice : voice
    }))
    return response.AudioStream?.transformToByteArray()
  }

  /** Returns MP3 bytes for `text`, spoken by `voice` at `rate` percent. */
  async synthesize(text: string, voice: SpeechVoice, rate: SpeechRate): Promise<Uint8Array> {
    const spoken = text.trim()
    if (!spoken || spoken.length > SPEECH_MAX_CHARS) throw new AppProblem('invalid_input', 'That reply is too long to read aloud.')
    const key = `${this.engine}|${voice}|${rate}|${spoken}`
    const cached = this.cache.get(key)
    if (cached) {
      // Refresh recency.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    let audio: Uint8Array | undefined
    try {
      audio = await this.request(spoken, voice, rate, this.engine)
    } catch (error) {
      if (this.engine !== 'neural' || !engineUnsupported(error)) throw describePollyError(error)
      console.warn(`Amazon Polly neural voices are not offered in ${this.region}; using standard voices.`)
      this.engine = 'standard'
      try { audio = await this.request(spoken, voice, rate, 'standard') }
      catch (retryError) { throw describePollyError(retryError) }
    }
    if (!audio?.byteLength) throw new AppProblem('polly_empty', 'Amazon Polly returned no audio.')
    this.cache.set(key, audio)
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!)
    return audio
  }

  dispose(): void {
    this.client?.destroy()
    this.client = null
    this.cache.clear()
  }
}

function describePollyError(error: unknown): AppProblem {
  if (error instanceof AppProblem) return error
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
  switch (name) {
    case 'CredentialsProviderError':
    case 'UnrecognizedClientException':
    case 'InvalidSignatureException':
    case 'ExpiredTokenException':
      return new AppProblem('aws_credentials', 'Amazon Polly needs valid AWS credentials. Set AWS_PROFILE or your access keys before starting Triage.')
    case 'AccessDeniedException':
      return new AppProblem('aws_access', 'These AWS credentials are not allowed to use Amazon Polly (polly:SynthesizeSpeech).')
    case 'ThrottlingException':
    case 'ServiceFailureException':
      return new AppProblem('aws_limit', 'Amazon Polly is busy right now. Try again in a moment.')
    case 'TextLengthExceededException':
    case 'InvalidSsmlException':
    case 'EngineNotSupportedException':
      return new AppProblem('polly_request', 'Amazon Polly could not read this reply aloud.')
    default:
      console.warn('Amazon Polly failed:', name || 'unknown error')
      return new AppProblem('aws_unavailable', 'Amazon Polly could not be reached. Check your internet connection.')
  }
}
