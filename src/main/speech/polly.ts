import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly'
import { SPEECH_MAX_CHARS, type SpeechRate, type SpeechVoice } from '../../shared/speech-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { awsRegionFromEnv } from '../aws/config.ts'

const CACHE_SIZE = 20

export function escapeSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Neural voices support <prosody rate>; slower speech is easier to follow for older listeners. */
export function buildSsml(text: string, rate: SpeechRate): string {
  return `<speak><prosody rate="${rate}%">${escapeSsml(text)}</prosody></speak>`
}

/** Amazon Polly text-to-speech, called only from the main process (which holds AWS credentials). */
export class PollyService {
  private client: PollyClient | null = null
  private cache = new Map<string, Uint8Array>()
  readonly region: string

  constructor(region = awsRegionFromEnv(process.env, process.env.TRIAGE_POLLY_REGION)) {
    this.region = region
  }

  private getClient(): PollyClient {
    this.client ??= new PollyClient({ region: this.region })
    return this.client
  }

  /** Returns MP3 bytes for `text`, spoken by `voice` at `rate` percent. */
  async synthesize(text: string, voice: SpeechVoice, rate: SpeechRate): Promise<Uint8Array> {
    const spoken = text.trim()
    if (!spoken || spoken.length > SPEECH_MAX_CHARS) throw new AppProblem('invalid_input', 'That reply is too long to read aloud.')
    const key = `${voice}|${rate}|${spoken}`
    const cached = this.cache.get(key)
    if (cached) {
      // Refresh recency.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    let audio: Uint8Array | undefined
    try {
      const response = await this.getClient().send(new SynthesizeSpeechCommand({
        Engine: 'neural',
        OutputFormat: 'mp3',
        SampleRate: '24000',
        TextType: 'ssml',
        Text: buildSsml(spoken, rate),
        VoiceId: voice
      }))
      audio = await response.AudioStream?.transformToByteArray()
    } catch (error) {
      throw describePollyError(error)
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
