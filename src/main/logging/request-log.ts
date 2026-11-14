import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { RequestEvent, RequestLogSettings } from '../../shared/request-log-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'

/** What the coordinator reports when a request ends; the log adds ids, consent and limits. */
export type FinishedRequest = Omit<RequestEvent, 'eventId' | 'installId' | 'appVersion'>

/** Anything that can receive finished requests (local outbox now, cloud uploader later). */
export interface RequestLog {
  record(request: FinishedRequest): void
}

const settingsSchema = z.object({ shareRequests: z.boolean(), installId: z.string().uuid() }).strict()
const MAX_TEXT = 1000
const MAX_REPLY = 600
const MAX_PENDING = 5000

/**
 * Opt-in local outbox: one JSON line per finished request in
 * <userData>/request-log.jsonl. Nothing is written unless the user opted in.
 */
export class LocalRequestLog implements RequestLog {
  private readonly settingsFile: string
  readonly outboxFile: string
  private readonly appVersion: string
  private shareRequests = false
  private installId: string = randomUUID()
  private pending = 0
  private warning?: string

  constructor(directory: string, appVersion: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.settingsFile = join(directory, 'request-log-settings.json')
    this.outboxFile = join(directory, 'request-log.jsonl')
    this.appVersion = appVersion
    if (existsSync(this.settingsFile)) {
      try {
        const saved = settingsSchema.parse(JSON.parse(readFileSync(this.settingsFile, 'utf8')))
        this.shareRequests = saved.shareRequests
        this.installId = saved.installId
      } catch { this.warning = 'Sharing settings could not be read, so sharing is off. Save to fix this.' }
    }
    this.pending = this.countPending()
  }

  snapshot(): RequestLogSettings {
    return { shareRequests: this.shareRequests, pending: this.pending, ...(this.warning ? { warning: this.warning } : {}) }
  }

  save(input: unknown): RequestLogSettings {
    const parsed = z.object({ shareRequests: z.boolean() }).strict().safeParse(input)
    if (!parsed.success) throw new AppProblem('invalid_input', 'Choose whether to share your questions.')
    this.persist(parsed.data.shareRequests, this.installId)
    return this.snapshot()
  }

  /** Deletes the outbox and starts a new anonymous id, so old and new requests cannot be linked. */
  clear(): RequestLogSettings {
    try { rmSync(this.outboxFile, { force: true }) }
    catch { throw new AppProblem('storage', 'Shared questions could not be deleted. Check disk access and try again.') }
    this.pending = 0
    this.persist(this.shareRequests, randomUUID())
    return this.snapshot()
  }

  record(request: FinishedRequest): void {
    if (!this.shareRequests || this.pending >= MAX_PENDING) return
    const event: RequestEvent = {
      ...request,
      text: request.text.slice(0, MAX_TEXT),
      ...(request.reply ? { reply: request.reply.slice(0, MAX_REPLY) } : {}),
      eventId: randomUUID(),
      installId: this.installId,
      appVersion: this.appVersion
    }
    try {
      appendFileSync(this.outboxFile, JSON.stringify(event) + '\n', { mode: 0o600 })
      this.pending++
    } catch { console.warn('A shared question could not be saved.') }
  }

  private persist(shareRequests: boolean, installId: string): void {
    try {
      writeFileSync(this.settingsFile + '.tmp', JSON.stringify({ shareRequests, installId }) + '\n', { mode: 0o600 })
      renameSync(this.settingsFile + '.tmp', this.settingsFile)
    } catch { throw new AppProblem('storage', 'Sharing settings could not be saved. Check disk access and try again.') }
    this.shareRequests = shareRequests
    this.installId = installId
    this.warning = undefined
  }

  private countPending(): number {
    try { return readFileSync(this.outboxFile, 'utf8').split('\n').filter((line) => line.trim()).length }
    catch { return 0 }
  }
}
