import { Document } from '@langchain/core/documents'
import type { VectorStoreRetriever } from '@langchain/core/vectorstores'
import { LocalHashEmbeddings } from './embeddings.ts'
import { SqliteVectorStore } from './store.ts'

export type MemoryKind = 'preference' | 'recipe' | 'fact'

export interface Recollection { id: string; kind: MemoryKind; text: string; key?: string; score: number; metadata: Record<string, unknown> }

/** A saved, replayable action trace for a site + task (design doc: "recipe replay"). */
export interface Recipe { site: string; task: string; steps: Array<{ action: string; field?: string; label: string }> }

/**
 * Personal memory for Triage, built on LangChain primitives:
 *   Document → Embeddings (on-device) → VectorStore (SQLite) → Retriever.
 *
 * Preferences have a `key` (e.g. "pharmacy") so restating one replaces the old
 * value instead of piling up contradictions. Recipes are keyed by site + task.
 * Everything is stored only on this Mac.
 */
export class MemoryService {
  readonly store: SqliteVectorStore

  constructor(file: string) {
    this.store = new SqliteVectorStore(new LocalHashEmbeddings(), file)
  }

  /** A standard LangChain retriever over one kind of memory, for use in chains and graphs. */
  retriever(kind: MemoryKind, k = 3): VectorStoreRetriever<SqliteVectorStore> {
    return this.store.asRetriever({ k, filter: { kind } })
  }

  async remember(kind: MemoryKind, text: string, metadata: Record<string, string | number | boolean> & { key?: string } = {}): Promise<string> {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1000)
    if (!clean) throw new Error('Nothing to remember.')
    const id = metadata.key ? `${kind}:${metadata.key}` : undefined
    const [saved] = await this.store.addDocuments([new Document({ pageContent: clean, metadata: { ...metadata, kind } })], id ? { ids: [id] } : undefined)
    return saved
  }

  async recall(query: string, options: { kind?: MemoryKind; k?: number; minScore?: number } = {}): Promise<Recollection[]> {
    const results = await this.store.similaritySearchWithScore(query, options.k ?? 5, options.kind ? { kind: options.kind } : undefined)
    return results
      .filter(([, score]) => score >= (options.minScore ?? 0.15))
      .map(([doc, score]) => ({
        id: doc.id ?? '', kind: doc.metadata.kind as MemoryKind, text: doc.pageContent, score, metadata: doc.metadata,
        ...(typeof doc.metadata.key === 'string' ? { key: doc.metadata.key } : {})
      }))
  }

  /** Exact lookup of a keyed preference, e.g. preference('pharmacy'). */
  preference(key: string): Recollection | undefined {
    const doc = this.store.list({ kind: 'preference', key }, 1)[0]
    return doc ? { id: doc.id ?? '', kind: 'preference', key, text: doc.pageContent, score: 1, metadata: doc.metadata } : undefined
  }

  async saveRecipe(recipe: Recipe): Promise<void> {
    await this.remember('recipe', `${recipe.task} on ${recipe.site}: ${recipe.steps.map((step) => step.label).join(', ')}`, {
      key: `${recipe.site}|${recipe.task}`, site: recipe.site, task: recipe.task, steps: JSON.stringify(recipe.steps)
    })
  }

  recipe(site: string, task: string): Recipe | undefined {
    const doc = this.store.list({ kind: 'recipe', key: `${site}|${task}` }, 1)[0]
    if (!doc) return undefined
    try { return { site, task, steps: JSON.parse(String(doc.metadata.steps)) as Recipe['steps'] } } catch { return undefined }
  }

  list(kind?: MemoryKind): Recollection[] {
    return this.store.list(kind ? { kind } : undefined).map((doc) => ({
      id: doc.id ?? '', kind: doc.metadata.kind as MemoryKind, text: doc.pageContent, score: 1, metadata: doc.metadata,
      ...(typeof doc.metadata.key === 'string' ? { key: doc.metadata.key } : {})
    }))
  }

  async forget(id: string): Promise<void> { await this.store.delete({ ids: [id] }) }

  close(): void { this.store.close() }
}

// ---------------------------------------------------------------------------
// "Remember that …" statements. Rules, not an LLM, decide what gets stored, so
// page text or a model reply can never write to memory on its own.
// ---------------------------------------------------------------------------

const KEYED: Array<{ key: string; pattern: RegExp }> = [
  { key: 'pharmacy', pattern: /\bmy (?:pharmacy|drugstore|chemist) is\b/i },
  { key: 'doctor', pattern: /\bmy (?:doctor|physician|gp) is\b/i },
  { key: 'pickup_time', pattern: /\bi (?:prefer|like) (?:to pick up |pickup )?(?:in the )?(morning|afternoon|evening)s?\b/i },
  { key: 'payment', pattern: /\b(?:always )?use (?:my |the )?(?:visa|mastercard|card|amex)\b/i },
  { key: 'name', pattern: /\bmy name is\b/i },
  { key: 'date_of_birth', pattern: /\bmy (?:date of birth|birthday|dob) is\b/i }
]
// The prescription number must contain a digit, so "my prescription is ready" is not a number.
const MEDICATION = /\b(?:my )?(.{2,60}?) (?:prescription|medication|medicine) (?:number )?(?:is )?#?\s*((?=[A-Z-]*\d)[A-Z0-9-]{4,20})\b/i

export interface MemoryStatement { kind: MemoryKind; text: string; key?: string; extra?: Record<string, string> }

/** Parse "remember (that) …". Returns null when the text is not a remember request. */
export function parseRememberCommand(text: string): MemoryStatement | null {
  const match = /^(?:\/remember|(?:please )?remember(?: that)?)\s+(.{3,500})$/i.exec(text.trim())
  if (!match) return null
  const fact = match[1].trim().replace(/[.!]+$/, '')
  const medication = MEDICATION.exec(fact)
  if (medication) {
    const name = medication[1].replace(/^(?:the|my)\s+/i, '').trim()
    return { kind: 'preference', key: 'medication:' + name.toLowerCase(), text: fact, extra: { medication: name, rx: medication[2].toUpperCase() } }
  }
  const keyed = KEYED.find(({ pattern }) => pattern.test(fact))
  return keyed ? { kind: 'preference', key: keyed.key, text: fact } : { kind: 'fact', text: fact }
}
