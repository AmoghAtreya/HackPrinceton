import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
  type LanguageCode,
  type Result
} from '@aws-sdk/client-transcribe-streaming'
import { AppProblem } from '../assistant/errors.ts'
import { awsRegionFromEnv } from '../aws/config.ts'

export interface TranscribeConfig {
  region: string
  languageCode: LanguageCode
}

/** One parsed Transcribe result, independent of the SDK's shapes. */
export interface TranscribeResult {
  segmentId: string
  text: string
  isFinal: boolean
  confidence: number | null
  startTime: number
  endTime: number
}

/**
 * Reads configuration from the environment. Credentials are resolved by the
 * AWS SDK's default Node chain (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY,
 * AWS_PROFILE, ~/.aws, SSO, …) inside the main process only.
 */
export function transcribeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TranscribeConfig {
  return {
    region: awsRegionFromEnv(env, env.TRIAGE_TRANSCRIBE_REGION),
    languageCode: (env.TRIAGE_TRANSCRIBE_LANGUAGE || 'en-US') as LanguageCode
  }
}

export class TranscribeService {
  private client: TranscribeStreamingClient | null = null
  readonly config: TranscribeConfig

  constructor(config: TranscribeConfig) {
    this.config = config
  }

  private getClient(): TranscribeStreamingClient {
    this.client ??= new TranscribeStreamingClient({ region: this.config.region })
    return this.client
  }

  /** Fails fast with a readable message when no AWS credentials are available. */
  async verifyCredentials(): Promise<void> {
    try {
      const credentials = await this.getClient().config.credentials()
      if (!credentials?.accessKeyId) throw new Error('empty credentials')
    } catch {
      throw new AppProblem('aws_credentials',
        'Amazon Transcribe needs AWS credentials. Set AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY before starting Triage.')
    }
  }

  /**
   * Streams PCM audio to Transcribe until `audio` ends, reporting every
   * partial and final result. Resolves once Transcribe closes the stream.
   */
  async stream(audio: AsyncIterable<Uint8Array>, sampleRate: number, signal: AbortSignal,
    onResult: (result: TranscribeResult) => void): Promise<void> {
    async function* events(): AsyncGenerator<AudioStream> {
      for await (const chunk of audio) {
        if (chunk.byteLength) yield { AudioEvent: { AudioChunk: chunk } }
      }
    }
    let response
    try {
      response = await this.getClient().send(new StartStreamTranscriptionCommand({
        LanguageCode: this.config.languageCode,
        MediaEncoding: 'pcm',
        MediaSampleRateHertz: sampleRate,
        AudioStream: events(),
        EnablePartialResultsStabilization: true,
        PartialResultsStability: 'medium'
      }), { abortSignal: signal })
    } catch (error) {
      throw describeAwsError(error, signal)
    }
    try {
      for await (const event of response.TranscriptResultStream ?? []) {
        for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
          const parsed = parseResult(result)
          if (parsed) onResult(parsed)
        }
      }
    } catch (error) {
      throw describeAwsError(error, signal)
    }
  }

  dispose(): void {
    this.client?.destroy()
    this.client = null
  }
}

export function parseResult(result: Result): TranscribeResult | null {
  const alternative = result.Alternatives?.[0]
  const text = alternative?.Transcript?.trim() ?? ''
  if (!result.ResultId) return null
  const isFinal = result.IsPartial === false
  const scores = (alternative?.Items ?? [])
    .filter((item) => item.Type === 'pronunciation' && typeof item.Confidence === 'number')
    .map((item) => item.Confidence as number)
  return {
    segmentId: result.ResultId,
    text,
    isFinal,
    confidence: isFinal && scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
    startTime: result.StartTime ?? 0,
    endTime: result.EndTime ?? 0
  }
}

function describeAwsError(error: unknown, signal: AbortSignal): AppProblem {
  if (error instanceof AppProblem) return error
  if (signal.aborted) return new AppProblem('voice_cancelled', 'Recording was cancelled.')
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
  switch (name) {
    case 'CredentialsProviderError':
    case 'UnrecognizedClientException':
    case 'InvalidSignatureException':
    case 'ExpiredTokenException':
      return new AppProblem('aws_credentials', 'Amazon Transcribe rejected the AWS credentials. Check AWS_PROFILE or your access keys.')
    case 'AccessDeniedException':
      return new AppProblem('aws_access', 'These AWS credentials are not allowed to use Amazon Transcribe streaming (transcribe:StartStreamTranscription).')
    case 'LimitExceededException':
      return new AppProblem('aws_limit', 'Amazon Transcribe is busy for this account. Wait a moment and try again.')
    case 'BadRequestException':
      return new AppProblem('aws_request', 'Amazon Transcribe could not use this recording. Try speaking again.')
    default:
      console.warn('Amazon Transcribe failed:', name || 'unknown error')
      return new AppProblem('aws_unavailable', 'Amazon Transcribe could not be reached. Check your internet connection and try again.')
  }
}
