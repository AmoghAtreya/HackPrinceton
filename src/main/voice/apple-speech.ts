import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppProblem } from '../assistant/errors.ts'
import type { SpeechToTextResult, SpeechToTextService } from './speech-to-text.ts'

const READY_TIMEOUT_MS = 20000
const MAX_LINE = 64 * 1024

/** Launches the helper app through Launch Services (`open`), so macOS gives it its own permission identity. */
export type HelperLauncher = (helperApp: string, args: string[]) => Promise<void>

export const launchWithOpen: HelperLauncher = (helperApp, args) => new Promise((resolve, reject) => {
  execFile('/usr/bin/open', ['-g', '-n', '-a', helperApp, '--args', ...args], { timeout: 10000 }, (error) => error ? reject(error) : resolve())
})

type HelperMessage =
  | { type: 'ready' }
  | { type: 'result'; text: string; isFinal: boolean; confidence: number | null }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' }

function parseMessage(line: string): HelperMessage | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    if (value.type === 'ready' || value.type === 'done') return { type: value.type }
    if (value.type === 'result' && typeof value.text === 'string' && typeof value.isFinal === 'boolean')
      return { type: 'result', text: value.text.slice(0, 12000), isFinal: value.isFinal, confidence: typeof value.confidence === 'number' ? value.confidence : null }
    if (value.type === 'error' && typeof value.code === 'string')
      return { type: 'error', code: value.code, message: typeof value.message === 'string' ? value.message : '' }
  } catch { /* Ignore malformed lines. */ }
  return null
}

function helperProblem(code: string): AppProblem {
  switch (code) {
    case 'speech_denied':
      return new AppProblem('speech_permission', 'Triage can’t use speech recognition. Allow “Triage Speech” in System Settings → Privacy & Security → Speech Recognition, then try again.')
    case 'no_on_device':
    case 'unsupported_language':
      return new AppProblem('speech_unavailable', 'On-device speech recognition isn’t available on this Mac. Turn on Dictation in System Settings → Keyboard to download it, then try again.')
    case 'unavailable':
      return new AppProblem('speech_unavailable', 'Speech recognition isn’t available right now. Please try again in a moment.')
    default:
      return new AppProblem('speech_failed', 'Speech recognition stopped unexpectedly. Please try again.')
  }
}

function frame(kind: 'A' | 'E' | 'C', payload?: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header[0] = kind.charCodeAt(0)
  header.writeUInt32BE(payload?.byteLength ?? 0, 1)
  return payload ? Buffer.concat([header, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)]) : header
}

/**
 * Free, on-device speech recognition through Apple's Speech framework.
 * Each recording launches the helper app, which connects back over a Unix
 * socket in a private temporary folder, receives the PCM audio and streams
 * results until the final one.
 */
export class AppleSpeechService implements SpeechToTextService {
  readonly name = 'Apple on-device speech'
  readonly id = 'apple' as const
  readonly config: { languageCode: string }
  private readonly helperApp: string
  private readonly launch: HelperLauncher

  constructor(helperApp: string, options: { languageCode?: string; launch?: HelperLauncher } = {}) {
    this.helperApp = helperApp
    this.config = { languageCode: options.languageCode ?? 'en-US' }
    this.launch = options.launch ?? launchWithOpen
  }

  async verify(): Promise<void> {
    if (process.platform !== 'darwin') throw new AppProblem('speech_unavailable', 'On-device speech recognition needs macOS.')
    if (!existsSync(join(this.helperApp, 'Contents', 'MacOS', 'TriageSpeechHelper')))
      throw new AppProblem('speech_helper_missing', 'The speech helper isn’t built yet. Run npm run speech:build, then restart Triage.')
  }

  async stream(audio: AsyncIterable<Uint8Array>, _sampleRate: number, signal: AbortSignal,
    onResult: (result: SpeechToTextResult) => void): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), 'triage-speech-'))
    const socketPath = join(directory, 's')
    const server: Server = createServer()
    let socket: Socket | undefined
    const startedAt = Date.now()
    let segment = 0
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
      const connection = new Promise<Socket>((resolve) => server.once('connection', resolve))
      await this.launch(this.helperApp, [socketPath, this.config.languageCode]).catch(() => {
        throw new AppProblem('speech_helper_missing', 'The speech helper could not be opened. Run npm run speech:build, then restart Triage.')
      })
      socket = await withTimeout(connection, READY_TIMEOUT_MS, signal)
      // Only the first connection is accepted.
      server.close()
      const helper = socket

      let pending = ''
      let settle!: { resolve: () => void; reject: (error: unknown) => void }
      let helperEnded = false
      const finished = new Promise<void>((resolve, reject) => {
        settle = { resolve: () => { helperEnded = true; resolve() }, reject: (error) => { helperEnded = true; reject(error) } }
      })
      // Awaited below; this only stops an early helper error from counting as unhandled.
      finished.catch(() => undefined)
      let ready!: () => void
      const readyPromise = new Promise<void>((resolve) => { ready = resolve })
      helper.setEncoding('utf8')
      helper.on('data', (chunk: string) => {
        pending += chunk
        if (pending.length > MAX_LINE * 4) { settle.reject(new AppProblem('speech_failed', 'Speech recognition sent too much data.')); helper.destroy(); return }
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const message = parseMessage(pending.slice(0, newline))
          pending = pending.slice(newline + 1)
          if (!message) continue
          if (message.type === 'ready') ready()
          else if (message.type === 'error') settle.reject(helperProblem(message.code))
          else if (message.type === 'done') settle.resolve()
          else {
            const seconds = (Date.now() - startedAt) / 1000
            onResult({ segmentId: `apple-${segment}`, text: message.text.trim(), isFinal: message.isFinal,
              confidence: message.isFinal ? message.confidence : null, startTime: 0, endTime: seconds })
            if (message.isFinal) segment++
          }
        }
      })
      helper.on('close', () => settle.resolve())
      helper.on('error', () => settle.resolve())
      const abort = () => { if (!helper.destroyed) { helper.write(frame('C')); helper.end() } }
      signal.addEventListener('abort', abort, { once: true })

      // Audio waits in the queue until the recognizer (and its permission prompt) is ready.
      await Promise.race([withTimeout(readyPromise, READY_TIMEOUT_MS * 3, signal), finished])
      for await (const chunk of audio) {
        if (signal.aborted || helper.destroyed || helperEnded) break
        helper.write(frame('A', chunk))
      }
      if (!signal.aborted && !helper.destroyed) helper.write(frame('E'))
      await finished
      signal.removeEventListener('abort', abort)
    } finally {
      socket?.destroy()
      server.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }

  dispose(): void {}
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppProblem('speech_timeout', 'Speech recognition took too long to start. If macOS asked about Speech Recognition, allow it and try again.')), ms)
    const abort = () => { clearTimeout(timer); reject(new AppProblem('voice_cancelled', 'Recording was cancelled.')) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value) },
      (error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) })
  })
}
