import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Command } from '@langchain/langgraph'
import type { MemoryService } from '../memory/service.ts'
import type { SqliteCheckpointer } from './checkpointer.ts'
import type { RefillDriver } from './pharmacy-driver.ts'
import { createRefillGraph, REFILL_STEP_COUNT, type RefillPrompt, type RefillValues } from './refill-graph.ts'

type GraphInput = Parameters<ReturnType<typeof createRefillGraph>['stream']>[0]

export type TaskStatus = 'waiting' | 'submitted' | 'cancelled' | 'blocked' | 'failed'

export interface TaskTurn { reply: string; status: TaskStatus }

export interface TaskSummary {
  threadId: string; conversationId: string; title: string; status: TaskStatus
  steps: string[]; stepCount: number; question: string | null; createdAt: number; updatedAt: number
}

/**
 * "Refill my blood pressure medicine", "can you refill my meds?", "/refill lisinopril".
 * Returns a normalised request, or null. Questions about refilling ("how do I
 * refill…") start with other words and are left to the normal chat.
 */
export function parseRefillCommand(text: string): string | null {
  const match = /^(?:\/refill\s+(.+?)|(?:(?:please|can you|could you|triage,?)\s+)*(?:refill|reorder|renew)\s+(?:my|the)\s+(.+?))\s*(?:please|for me)?\s*[.!?]*$/i.exec(text.trim())
  if (!match) return null
  return 'refill my ' + (match[1] ?? match[2]).trim()
}

export const WHERE_WAS_I = /^(?:where was i|where were we|what was i doing|what step (?:am i|are we) on)\??$/i

/**
 * Runs task graphs per conversation. A conversation has at most one paused
 * task; the person's next chat message answers its question. Thread metadata
 * lives next to the LangGraph checkpoints so the History tab can list tasks
 * and their saved progress, including after a restart.
 */
export class TaskRunner {
  private readonly db: DatabaseSync
  private readonly graph: ReturnType<typeof createRefillGraph>
  private readonly now: () => number

  constructor(options: { file: string; memory: MemoryService; driver: RefillDriver; checkpointer: SqliteCheckpointer; now?: () => number }) {
    this.now = options.now ?? Date.now
    if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(options.file)
    if (options.file !== ':memory:') chmodSync(options.file, 0o600)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS task_threads (
        thread_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL, steps_json TEXT NOT NULL, question TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_threads_conversation ON task_threads(conversation_id, updated_at);
    `)
    this.graph = createRefillGraph({ memory: options.memory, driver: options.driver, checkpointer: options.checkpointer, today: () => new Date(this.now()) })
  }

  /** The paused task in this conversation, if any. */
  waiting(conversationId: string): TaskSummary | undefined {
    const row = this.db.prepare("SELECT * FROM task_threads WHERE conversation_id = ? AND status = 'waiting' ORDER BY updated_at DESC LIMIT 1").get(conversationId)
    return row ? this.decode(row) : undefined
  }

  async start(conversationId: string, request: string, onStep: (step: string) => void): Promise<TaskTurn> {
    const previous = this.waiting(conversationId)
    if (previous) this.update(previous.threadId, 'cancelled', previous.steps.concat('Replaced by a new request'), null)
    const threadId = randomUUID()
    const now = this.now()
    this.db.prepare(`INSERT INTO task_threads (thread_id, conversation_id, kind, title, status, steps_json, question, created_at, updated_at)
      VALUES (?, ?, 'refill', ?, 'waiting', '[]', NULL, ?, ?)`).run(threadId, conversationId, request.slice(0, 120), now, now)
    return this.drive(threadId, { request }, onStep)
  }

  async resume(conversationId: string, answer: string, onStep: (step: string) => void): Promise<TaskTurn> {
    const task = this.waiting(conversationId)
    if (!task) return { reply: 'There is no paused task in this conversation.', status: 'failed' }
    // Command's node-name generic is wider than this graph's; the resume value is all it carries.
    return this.drive(task.threadId, new Command({ resume: answer }) as GraphInput, onStep)
  }

  private async drive(threadId: string, input: GraphInput, onStep: (step: string) => void): Promise<TaskTurn> {
    const config = { configurable: { thread_id: threadId } }
    let prompt: RefillPrompt | undefined
    try {
      const stream = await this.graph.stream(input, { ...config, streamMode: 'updates' })
      for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
        for (const [node, update] of Object.entries(chunk)) {
          if (node === '__interrupt__') {
            const first = (update as Array<{ value: RefillPrompt }>)[0]
            if (first) prompt = first.value
          } else {
            for (const step of ((update as Partial<RefillValues> | null)?.steps ?? [])) onStep(step)
          }
        }
      }
    } catch (error) {
      const values = (await this.graph.getState(config)).values as RefillValues
      this.update(threadId, 'failed', values.steps.concat('Something went wrong; nothing more was sent'), null)
      throw error
    }
    const values = (await this.graph.getState(config)).values as RefillValues
    if (prompt) {
      const question = prompt.kind === 'confirm' ? prompt.summary : prompt.question
      this.update(threadId, 'waiting', values.steps, question)
      return { reply: question + (prompt.kind === 'question' ? '\n(Say "cancel" to stop.)' : ''), status: 'waiting' }
    }
    const status: TaskStatus = values.outcome === 'in_progress' ? 'failed' : values.outcome
    this.update(threadId, status, values.steps, null)
    const replies: Record<TaskStatus, string> = {
      submitted: `Done. Your ${values.medication} refill was requested at CareWell. Confirmation number ${values.confirmation}. You pay at pickup.`,
      cancelled: 'Okay, I stopped. Nothing was sent to the pharmacy.',
      blocked: 'I stopped before sending anything: that page asks for payment or a password, which I never submit for you.',
      failed: 'I could not finish the refill. Nothing more was sent.',
      waiting: ''
    }
    return { reply: replies[status], status }
  }

  /** "Where was I?" for this conversation, from saved progress. */
  whereWasI(conversationId?: string): string {
    // Prefer this conversation's task; otherwise the most recent paused task anywhere.
    const local = conversationId ? this.waiting(conversationId) ?? this.list(conversationId)[0] : undefined
    const task = local ?? this.list().find((item) => item.status === 'waiting') ?? this.list()[0]
    if (!task) return 'You have no tasks in progress.'
    const elsewhere = task.conversationId !== conversationId ? ' (in an earlier conversation; open it from History to continue)' : ''
    const done = task.steps.length
    const head = task.status === 'waiting'
      ? `You were working on: ${task.title}${elsewhere}. ${Math.min(done, REFILL_STEP_COUNT)} of about ${REFILL_STEP_COUNT} steps are done.`
      : `Your last task, "${task.title}", is ${task.status === 'submitted' ? 'finished' : task.status}.`
    const last = task.steps.at(-1)
    return [head, last ? `Last step: ${last}.` : '', task.question ? `I was asking:\n${task.question}` : ''].filter(Boolean).join('\n')
  }

  /** Tasks for the History tab, newest first. */
  list(conversationId?: string, limit = 20): TaskSummary[] {
    const rows = conversationId
      ? this.db.prepare('SELECT * FROM task_threads WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT ?').all(conversationId, limit)
      : this.db.prepare('SELECT * FROM task_threads ORDER BY updated_at DESC LIMIT ?').all(limit)
    return rows.map((row) => this.decode(row))
  }

  private update(threadId: string, status: TaskStatus, steps: string[], question: string | null): void {
    this.db.prepare('UPDATE task_threads SET status = ?, steps_json = ?, question = ?, updated_at = ? WHERE thread_id = ?')
      .run(status, JSON.stringify(steps), question, this.now(), threadId)
  }

  private decode(raw: unknown): TaskSummary {
    const row = raw as { thread_id: string; conversation_id: string; title: string; status: TaskStatus; steps_json: string; question: string | null; created_at: number; updated_at: number }
    return {
      threadId: row.thread_id, conversationId: row.conversation_id, title: row.title, status: row.status,
      steps: JSON.parse(row.steps_json) as string[], stepCount: REFILL_STEP_COUNT, question: row.question,
      createdAt: row.created_at, updatedAt: row.updated_at
    }
  }

  close(): void { this.db.close() }
}
