import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Document, type DocumentInterface } from '@langchain/core/documents'
import type { EmbeddingsInterface } from '@langchain/core/embeddings'
import { VectorStore } from '@langchain/core/vectorstores'

/** Exact-match filter on document metadata, e.g. { kind: 'preference' }. */
export type MemoryFilter = Record<string, string | number | boolean>

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/**
 * A LangChain VectorStore persisted in SQLite (node:sqlite, no native addon,
 * so it works inside Electron and the packaged app). Search is an exact cosine
 * scan, which is fast for the hundreds-to-low-thousands of memories one person
 * accumulates; swap in sqlite-vec or similar if that ever grows.
 */
export class SqliteVectorStore extends VectorStore {
  declare FilterType: MemoryFilter
  private db: DatabaseSync

  _vectorstoreType(): string { return 'triage-sqlite' }

  constructor(embeddings: EmbeddingsInterface, file: string) {
    super(embeddings, {})
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    if (file !== ':memory:') chmodSync(file, 0o600)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, metadata_json TEXT NOT NULL,
        vector_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
  }

  async addVectors(vectors: number[][], documents: DocumentInterface[], options?: { ids?: string[] }): Promise<string[]> {
    const ids: string[] = []
    const now = Date.now()
    const upsert = this.db.prepare(`INSERT INTO memories (id, content, metadata_json, vector_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, metadata_json = excluded.metadata_json, vector_json = excluded.vector_json, updated_at = excluded.updated_at`)
    documents.forEach((doc, index) => {
      const id = options?.ids?.[index] ?? doc.id ?? randomUUID()
      upsert.run(id, doc.pageContent, JSON.stringify(doc.metadata ?? {}), JSON.stringify(vectors[index]), now, now)
      ids.push(id)
    })
    return ids
  }

  async addDocuments(documents: DocumentInterface[], options?: { ids?: string[] }): Promise<string[]> {
    return this.addVectors(await this.embeddings.embedDocuments(documents.map((doc) => doc.pageContent)), documents, options)
  }

  async similaritySearchVectorWithScore(query: number[], k: number, filter?: MemoryFilter): Promise<[DocumentInterface, number][]> {
    const rows = this.db.prepare('SELECT id, content, metadata_json, vector_json FROM memories').all() as Array<{ id: string; content: string; metadata_json: string; vector_json: string }>
    const scored: [DocumentInterface, number][] = []
    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>
      if (filter && Object.entries(filter).some(([key, value]) => metadata[key] !== value)) continue
      const score = cosine(query, JSON.parse(row.vector_json) as number[])
      // The score is also copied into metadata: plain retrievers drop it, and the learning monitor shows it.
      scored.push([new Document({ id: row.id, pageContent: row.content, metadata: { ...metadata, score } }), score])
    }
    return scored.sort((a, b) => b[1] - a[1]).slice(0, k)
  }

  async delete(params?: { ids?: string[]; filter?: MemoryFilter }): Promise<void> {
    if (params?.ids?.length) for (const id of params.ids) this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    if (params?.filter) {
      const rows = this.db.prepare('SELECT id, metadata_json FROM memories').all() as Array<{ id: string; metadata_json: string }>
      for (const row of rows) {
        const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>
        if (Object.entries(params.filter).every(([key, value]) => metadata[key] === value)) this.db.prepare('DELETE FROM memories WHERE id = ?').run(row.id)
      }
    }
  }

  /** All documents matching a filter, newest first (for listing memories in the UI). */
  list(filter?: MemoryFilter, limit = 200): DocumentInterface[] {
    const rows = this.db.prepare('SELECT id, content, metadata_json FROM memories ORDER BY updated_at DESC LIMIT ?').all(limit * 5) as Array<{ id: string; content: string; metadata_json: string }>
    return rows.map((row) => new Document({ id: row.id, pageContent: row.content, metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }))
      .filter((doc) => !filter || Object.entries(filter).every(([key, value]) => doc.metadata[key] === value))
      .slice(0, limit)
  }

  close(): void { this.db.close() }
}
