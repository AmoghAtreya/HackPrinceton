import type { ActivityEvent } from '../../shared/flight-contracts.ts'
import type { HighlightReply, HighlightSource } from '../../shared/highlight-contracts.ts'
import type { ShakeTrigger } from '../../shared/shake-contracts.ts'
import type { CaptureMetadata } from '../../shared/screen-contracts.ts'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConversationDetail, ConversationPage, ConversationSummary, HistoryCursor, RequestStatus, SavedMessage, SendReceipt } from '../../shared/assistant-contracts.ts'
import { AppProblem } from './errors.ts'
import { redact } from './redaction.ts'
import { z } from 'zod'
import { steps } from '../../shared/flight-contracts.ts'

// Persist only the public workflow record, even if a future worker sends extras.
const activityData = z.object({
  actionId: z.string().uuid().optional(), step: z.enum(steps).optional(),
  parentTaskId: z.string().uuid().optional(), stage: z.enum(['capturing', 'thinking', 'browser']).optional(),
  input: z.object({
    originAirport: z.string().regex(/^[A-Z]{3}$/), destinationAirport: z.string().regex(/^[A-Z]{3}$/),
    tripType: z.enum(['one_way', 'round_trip']), departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), adults: z.number().int().min(1).max(7)
  }).optional(),
  outcome: z.object({
    status: z.enum(['results', 'no_results', 'blocked', 'failed']), detail: z.string().max(1000).transform((text) => redact(text)),
    finalUrl: z.string().transform((value) => {
      try {
        const url = new URL(value)
        if (url.origin !== 'https://www.alaskaair.com' || !['/search', '/search/', '/search/results'].includes(url.pathname)) return ''
        const clean = new URL(url.origin + url.pathname)
        for (const key of ['O', 'D', 'OD', 'DD', 'A', 'RT']) {
          const item = url.searchParams.get(key)
          if (item && /^(?:[A-Z]{3}|\d{4}-\d{2}-\d{2}|[1-7]|true|false)$/.test(item)) clean.searchParams.set(key, item)
        }
        return clean.href
      } catch { return '' }
    })
  }).optional()
})

export class HistoryStore {
  private db!: DatabaseSync
  private closed = false

  constructor(file: string) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      this.db = new DatabaseSync(file)
      chmodSync(file, 0o600)
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version > 1) throw new AppProblem('storage', 'This history was created by a newer Triage version.')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          status TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER,
          error TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          type TEXT NOT NULL, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS conversation_order ON conversations(updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS message_order ON messages(conversation_id, seq);
        CREATE INDEX IF NOT EXISTS task_order ON tasks(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS event_task_type ON events(task_id, type, seq);
        PRAGMA user_version = 1;
      `)
      this.recover()
    } catch (error) {
      this.db?.close()
      throw error instanceof AppProblem ? error : new AppProblem('storage', 'Saved history could not be opened. Check disk access and restart Triage.')
    }
  }

  private transaction<T>(operation: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* BEGIN or storage itself may have failed. */ }
      if (error instanceof AppProblem) throw error
      throw new AppProblem('storage', 'History could not be saved. Check available disk space and restart Triage.')
    }
  }

  private event(conversationId: string, taskId: string, type: string, payload: object = {}): void {
    this.db.prepare('INSERT INTO events(conversation_id, task_id, type, created_at, payload_json) VALUES(?,?,?,?,?)')
      .run(conversationId, taskId, type, Date.now(), JSON.stringify(payload))
  }

  private recover(): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT id, conversation_id FROM tasks WHERE status = 'running'").all() as Array<{ id: string; conversation_id: string }>
      for (const row of rows) {
        this.db.prepare("UPDATE tasks SET status='interrupted', finished_at=?, error=? WHERE id=?")
          .run(Date.now(), 'Triage closed before a reply was saved.', row.id)
        this.unknownActions(row.id, row.conversation_id)
        this.event(row.conversation_id, row.id, 'request_interrupted', { detail: 'Triage exited during this request. Actions were not replayed.' })
      }
    })
  }

  begin(text: string, model: string, conversationId?: string, capture?: CaptureMetadata, gesture?: ShakeTrigger & { instruction: string }, source: 'chat' | 'voice' = 'chat'): SendReceipt {
    return this.transaction(() => {
      const now = Date.now()
      const id = conversationId ?? randomUUID()
      const safe = redact(text)
      if (conversationId) this.summary(id)
      else this.db.prepare('INSERT INTO conversations(id,title,updated_at) VALUES(?,?,?)')
        .run(id, safe.replace(/\s+/g, ' ').slice(0, 64), now)
      const taskId = randomUUID()
      this.db.prepare("INSERT INTO tasks(id,conversation_id,status,model,created_at) VALUES(?,?,'running',?,?)")
        .run(taskId, id, model, now)
      this.db.prepare("INSERT INTO messages(id,conversation_id,task_id,role,content,created_at) VALUES(?,?,?,'user',?,?)")
        .run(randomUUID(), id, taskId, safe, now)
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, id)
      this.event(id, taskId, 'request_started', { model, source: gesture ? 'shake' : source, ...(capture ? { capture } : {}), ...(gesture ? { gesture } : {}) })
      return { taskId, conversationId: id }
    })
  }

  attachCapture(taskId: string, capture: CaptureMetadata): void {
    this.transaction(() => {
      const task = this.db.prepare("SELECT conversation_id FROM tasks WHERE id=? AND status='running'").get(taskId) as { conversation_id: string } | undefined
      if (!task) throw new AppProblem('not_active', 'This screen request is no longer active.')
      this.event(task.conversation_id, taskId, 'screen_captured', { capture })
    })
  }

  complete(taskId: string, content: string, highlight?: Omit<HighlightReply, 'explanation' | 'elementId'> & { outcome: string; source?: HighlightSource }): boolean {
    return this.transaction(() => {
      const task = this.db.prepare("SELECT conversation_id FROM tasks WHERE id=? AND status='running'").get(taskId) as { conversation_id: string } | undefined
      if (!task) return false
      const now = Date.now()
      this.db.prepare("INSERT INTO messages(id,conversation_id,task_id,role,content,created_at) VALUES(?,?,?,'assistant',?,?)")
        .run(randomUUID(), task.conversation_id, taskId, redact(content), now)
      this.db.prepare("UPDATE tasks SET status='completed',finished_at=? WHERE id=?").run(now, taskId)
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, task.conversation_id)
      this.unknownActions(taskId, task.conversation_id)
      this.event(task.conversation_id, taskId, 'reply_completed', highlight ? { highlight } : {})
      return true
    })
  }

  /** Adds a follow-up assistant message to an already completed task, e.g. when its highlight was lost. */
  note(taskId: string, type: string, content: string): boolean {
    return this.transaction(() => {
      const task = this.db.prepare("SELECT conversation_id FROM tasks WHERE id=? AND status='completed'").get(taskId) as { conversation_id: string } | undefined
      if (!task) return false
      const now = Date.now()
      const safe = redact(content).slice(0, 1500)
      this.db.prepare("INSERT INTO messages(id,conversation_id,task_id,role,content,created_at) VALUES(?,?,?,'assistant',?,?)")
        .run(randomUUID(), task.conversation_id, taskId, safe, now)
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, task.conversation_id)
      this.event(task.conversation_id, taskId, type, { detail: safe })
      return true
    })
  }

  finish(taskId: string, status: Exclude<RequestStatus, 'running' | 'completed'>, error: string | null = null): void {
    this.transaction(() => {
      const task = this.db.prepare("SELECT conversation_id FROM tasks WHERE id=? AND status='running'").get(taskId) as { conversation_id: string } | undefined
      if (!task) return
      this.db.prepare('UPDATE tasks SET status=?,finished_at=?,error=? WHERE id=?')
        .run(status, Date.now(), error ? redact(error) : null, taskId)
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(Date.now(), task.conversation_id)
      this.unknownActions(taskId, task.conversation_id)
      this.event(task.conversation_id, taskId, 'request_' + status, error ? { message: redact(error) } : {})
    })
  }

  activity(taskId: string, type: string, detail: string, data: object = {}): void {
    this.transaction(() => {
      const task = this.db.prepare("SELECT conversation_id FROM tasks WHERE id=? AND status='running'").get(taskId) as { conversation_id: string } | undefined
      if (!task) throw new AppProblem('not_active', 'This task is no longer active.')
      this.event(task.conversation_id, taskId, type, { ...activityData.parse(data), detail: redact(detail).slice(0, 1500) })
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(Date.now(), task.conversation_id)
    })
  }

  clarificationParent(conversationId: string): string | undefined {
    const row = this.db.prepare("SELECT task_id FROM events WHERE conversation_id=? AND type='flight_clarification' ORDER BY seq DESC LIMIT 1").get(conversationId) as { task_id: string } | undefined
    return row?.task_id
  }

  private unknownActions(taskId: string, conversationId: string): void {
    const pending = this.db.prepare(`SELECT json_extract(p.payload_json,'$.actionId') AS actionId
      FROM events p WHERE p.task_id=? AND p.type='action_pending' AND NOT EXISTS (
        SELECT 1 FROM events r WHERE r.task_id=p.task_id AND r.type IN ('action_observed','action_unknown')
        AND json_extract(r.payload_json,'$.actionId')=json_extract(p.payload_json,'$.actionId'))`).all(taskId) as Array<{ actionId: string }>
    for (const action of pending) this.event(conversationId, taskId, 'action_unknown', {
      actionId: action.actionId, detail: 'Outcome unknown: this action was issued but its effect could not be verified. Stop does not undo a submitted search.'
    })
  }

  summary(id: string): ConversationSummary {
    const row = this.db.prepare('SELECT id,title,updated_at AS updatedAt FROM conversations WHERE id=?').get(id) as unknown as ConversationSummary | undefined
    if (!row) throw new AppProblem('not_found', 'This conversation no longer exists.')
    return row
  }

  list(before?: HistoryCursor): ConversationPage {
    const rows = (before
      ? this.db.prepare('SELECT id,title,updated_at AS updatedAt FROM conversations WHERE updated_at < ? OR (updated_at = ? AND id < ?) ORDER BY updated_at DESC,id DESC LIMIT 26')
        .all(before.at, before.at, before.id)
      : this.db.prepare('SELECT id,title,updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC,id DESC LIMIT 26').all()
    ) as unknown as ConversationSummary[]
    const items = rows.slice(0, 25)
    const last = items.at(-1)
    return { items, next: rows.length > 25 && last ? { at: last.updatedAt, id: last.id } : null }
  }

  detail(id: string, before = Number.MAX_SAFE_INTEGER, beforeEvent = Number.MAX_SAFE_INTEGER): ConversationDetail {
    const conversation = this.summary(id)
    const rows = this.db.prepare(`
      SELECT m.seq,m.id,m.task_id AS taskId,m.role,m.content,m.created_at AS createdAt,t.status,t.error,
        CASE WHEN m.role='user' THEN COALESCE((SELECT json_extract(e.payload_json,'$.source')
          FROM events e WHERE e.task_id=m.task_id AND e.type='request_started' ORDER BY e.seq LIMIT 1), 'chat') END AS source
      FROM messages m JOIN tasks t ON t.id=m.task_id
      WHERE m.conversation_id=? AND m.seq < ? ORDER BY m.seq DESC LIMIT 101
    `).all(id, before) as unknown as SavedMessage[]
    for (const row of rows) if (row.role !== 'user') delete row.source
    const messages = rows.slice(0, 100).reverse()
    const events = this.db.prepare(`SELECT seq,task_id AS taskId,type,created_at AS createdAt,
      COALESCE(json_extract(payload_json,'$.detail'),json_extract(payload_json,'$.message'),
        CASE type WHEN 'request_started' THEN 'Request accepted.'
          WHEN 'reply_completed' THEN 'Reply saved.'
          WHEN 'screen_captured' THEN 'Screen captured. Image bytes were not saved.'
          ELSE type END) AS detail
      FROM events WHERE conversation_id=? AND seq < ? ORDER BY seq DESC LIMIT 201`).all(id, beforeEvent) as unknown as ActivityEvent[]
    const activity = events.slice(0, 200).reverse()
    return { conversation, messages, activity, nextActivityBefore: events.length > 200 ? activity[0].seq : null, nextBefore: rows.length > 100 ? messages[0].seq : null }
  }

  context(conversationId: string, currentTaskId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
    // Failed/stopped/interrupted turns are reviewable history, not completed dialogue.
    const rows = this.db.prepare(`
      SELECT m.role,m.content FROM messages m JOIN tasks t ON t.id=m.task_id
      WHERE m.conversation_id=? AND (t.status='completed' OR t.id=?)
      ORDER BY m.seq DESC LIMIT 80
    `).all(conversationId, currentTaskId) as Array<{ role: 'user' | 'assistant'; content: string }>
    let length = 0
    const recent: typeof rows = []
    for (const row of rows) {
      if (recent.length === 20 || length + row.content.length > 24000) break
      recent.unshift(row)
      length += row.content.length
    }
    while (recent[0]?.role === 'assistant') recent.shift()
    return recent
  }

  delete(id: string): void {
    this.transaction(() => { this.db.prepare('DELETE FROM conversations WHERE id=?').run(id) })
  }

  clear(): void {
    this.transaction(() => { this.db.exec('DELETE FROM conversations') })
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { this.db.close() }
  }
}
