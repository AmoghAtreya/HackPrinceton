import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MemorySaver } from '@langchain/langgraph'
import type { RunnableConfig } from '@langchain/core/runnables'
import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint'

// MemorySaver keeps Uint8Array blobs; tag them so JSON can round-trip them.
const encode = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item instanceof Uint8Array ? { __u8: Buffer.from(item).toString('base64') } : item)
const decode = (text: string): unknown => JSON.parse(text, (_key, item) =>
  item && typeof item === 'object' && typeof item.__u8 === 'string' ? new Uint8Array(Buffer.from(item.__u8, 'base64')) : item)

function threadOfWriteKey(key: string): string | undefined {
  try { return (JSON.parse(key) as string[])[0] } catch { return undefined }
}

/**
 * LangGraph checkpointer that survives restarts: LangGraph's own MemorySaver
 * (all checkpoint logic, ordering and safety guards) with each thread's state
 * mirrored into SQLite after every write. A task paused at "Shall I submit?"
 * can therefore resume after Triage quits, and its step history stays readable.
 *
 * Uses node:sqlite (no native addon), so it runs in Electron and the packaged app.
 */
export class SqliteCheckpointer extends MemorySaver {
  private db: DatabaseSync

  constructor(file: string) {
    super()
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    if (file !== ':memory:') chmodSync(file, 0o600)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS langgraph_threads (
        thread_id TEXT PRIMARY KEY, storage_json TEXT NOT NULL, writes_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
    const rows = this.db.prepare('SELECT thread_id, storage_json, writes_json FROM langgraph_threads').all() as Array<{ thread_id: string; storage_json: string; writes_json: string }>
    for (const row of rows) {
      this.storage[row.thread_id] = decode(row.storage_json) as typeof this.storage[string]
      Object.assign(this.writes, decode(row.writes_json) as typeof this.writes)
    }
  }

  private persist(threadId: unknown): void {
    if (typeof threadId !== 'string') return
    const thread = this.storage[threadId]
    if (!thread) { this.db.prepare('DELETE FROM langgraph_threads WHERE thread_id = ?').run(threadId); return }
    const writes = Object.fromEntries(Object.entries(this.writes).filter(([key]) => threadOfWriteKey(key) === threadId))
    this.db.prepare(`INSERT INTO langgraph_threads (thread_id, storage_json, writes_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET storage_json = excluded.storage_json, writes_json = excluded.writes_json, updated_at = excluded.updated_at`)
      .run(threadId, encode(thread), encode(writes), Date.now())
  }

  override async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const result = await super.put(config, checkpoint, metadata)
    this.persist(config.configurable?.thread_id)
    return result
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    await super.putWrites(config, writes, taskId, taskPath)
    this.persist(config.configurable?.thread_id)
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId)
    this.persist(threadId)
  }

  close(): void { this.db.close() }
}
