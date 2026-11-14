import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  entityInputSchema, provenances,
  type ChannelType, type EntityInput, type EntityKind, type Provenance, type TrustChannel, type TrustDecision, type TrustEntity, type TrustGraph, type Verdict
} from '../../shared/trust-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { normalizeChannel, normalizeName } from './normalize.ts'

/**
 * What the screen-checking code is given: it can look things up and nothing
 * else. Writing needs the full TrustStore and a provenance, which only the
 * user-facing entry points (Settings, a confirmed chat statement, a decision
 * button, the built-in seed list) ever hold.
 */
export interface TrustReader {
  entities(): TrustEntity[]
  decisions(): TrustDecision[]
}

interface EntityRow { id: string; kind: EntityKind; name: string; relationship: string; aliases_json: string; source: Provenance; created_at: number; updated_at: number }
interface ChannelRow { id: string; entity_id: string; type: ChannelType; value: string; source: Provenance; created_at: number }

export class TrustStore implements TrustReader {
  private db: DatabaseSync
  private now: () => number

  constructor(file: string, now: () => number = Date.now) {
    this.now = now
    try {
      if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      this.db = new DatabaseSync(file)
      if (file !== ':memory:') chmodSync(file, 0o600)
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('person','organization')), name TEXT NOT NULL,
          name_key TEXT NOT NULL, relationship TEXT NOT NULL DEFAULT '', aliases_json TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL CHECK(source IN ('user','caregiver','seed')), seed_key TEXT UNIQUE,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK(type IN ('email','phone','website')), value TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('user','caregiver','seed')), created_at INTEGER NOT NULL,
          UNIQUE(entity_id, type, value)
        );
        CREATE TABLE IF NOT EXISTS decisions (
          id TEXT PRIMARY KEY, verdict TEXT NOT NULL CHECK(verdict IN ('scam','genuine')), claimed_name TEXT NOT NULL,
          channel_type TEXT NOT NULL CHECK(channel_type IN ('email','phone','website')), channel_value TEXT NOT NULL,
          entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL, created_at INTEGER NOT NULL,
          UNIQUE(claimed_name, channel_type, channel_value)
        );
        CREATE TABLE IF NOT EXISTS removed_seeds (seed_key TEXT PRIMARY KEY);
      `)
    } catch (error) {
      throw error instanceof AppProblem ? error : new AppProblem('trust_storage', 'The list of people and organizations could not be opened. Check disk access and restart Triage.')
    }
  }

  private write<T>(operation: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* The transaction may not have started. */ }
      if (error instanceof AppProblem) throw error
      throw new AppProblem('trust_storage', 'That change could not be saved. Check available disk space.')
    }
  }
  private static vouched(source: Provenance): void {
    // A runtime check as well as a type: a caller built from untyped input still cannot invent a provenance.
    if (!provenances.includes(source)) throw new AppProblem('untrusted_source', 'Only you or a caregiver can add to this list.')
  }

  entities(): TrustEntity[] {
    const channels = this.db.prepare('SELECT id, entity_id, type, value, source, created_at FROM channels ORDER BY created_at, id').all() as unknown as ChannelRow[]
    const byEntity = new Map<string, TrustChannel[]>()
    for (const row of channels) {
      const list = byEntity.get(row.entity_id) ?? []
      list.push({ id: row.id, type: row.type, value: row.value, source: row.source, createdAt: row.created_at })
      byEntity.set(row.entity_id, list)
    }
    const rows = this.db.prepare('SELECT id, kind, name, relationship, aliases_json, source, created_at, updated_at FROM entities ORDER BY kind DESC, name COLLATE NOCASE').all() as unknown as EntityRow[]
    return rows.map((row) => ({
      id: row.id, kind: row.kind, name: row.name, relationship: row.relationship, aliases: JSON.parse(row.aliases_json) as string[],
      channels: byEntity.get(row.id) ?? [], source: row.source, createdAt: row.created_at, updatedAt: row.updated_at
    }))
  }
  decisions(): TrustDecision[] {
    return (this.db.prepare('SELECT id, verdict, claimed_name, channel_type, channel_value, entity_id, created_at FROM decisions ORDER BY created_at DESC, id').all() as Array<Record<string, unknown>>)
      .map((row) => ({ id: row.id as string, verdict: row.verdict as Verdict, claimedName: row.claimed_name as string, channelType: row.channel_type as ChannelType,
        channelValue: row.channel_value as string, entityId: row.entity_id as string | null, createdAt: row.created_at as number }))
  }
  graph(): TrustGraph { return { entities: this.entities(), decisions: this.decisions() } }

  addEntity(input: EntityInput, source: Provenance, seedKey?: string): TrustEntity {
    TrustStore.vouched(source)
    const parsed = entityInputSchema.safeParse(input)
    if (!parsed.success) throw new AppProblem('invalid_input', 'Check the name and contact details and try again.')
    const entity = parsed.data
    if (!normalizeName(entity.name)) throw new AppProblem('invalid_input', 'Enter a name.')
    const channels = entity.channels.map((channel) => ({ type: channel.type, value: normalizeChannel(channel.type, channel.value) }))
    const id = randomUUID()
    const now = this.now()
    this.write(() => {
      this.db.prepare('INSERT INTO entities(id,kind,name,name_key,relationship,aliases_json,source,seed_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, entity.kind, entity.name, normalizeName(entity.name), entity.relationship, JSON.stringify(entity.aliases), source, seedKey ?? null, now, now)
      for (const channel of channels) {
        this.db.prepare('INSERT OR IGNORE INTO channels(id,entity_id,type,value,source,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), id, channel.type, channel.value, source, now)
      }
    })
    return this.entities().find((item) => item.id === id)!
  }

  updateEntity(id: string, changes: { name: string; relationship: string; aliases: string[] }, source: Provenance): void {
    TrustStore.vouched(source)
    if (!normalizeName(changes.name)) throw new AppProblem('invalid_input', 'Enter a name.')
    this.write(() => {
      const result = this.db.prepare('UPDATE entities SET name=?, name_key=?, relationship=?, aliases_json=?, updated_at=? WHERE id=?')
        .run(changes.name.trim().slice(0, 80), normalizeName(changes.name), changes.relationship.trim().slice(0, 80), JSON.stringify(changes.aliases.slice(0, 8)), this.now(), id)
      if (!result.changes) throw new AppProblem('not_found', 'That entry is no longer in the list.')
    })
  }

  addChannel(entityId: string, type: ChannelType, value: string, source: Provenance): void {
    TrustStore.vouched(source)
    const normalized = normalizeChannel(type, value)
    this.write(() => {
      if (!this.db.prepare('SELECT 1 FROM entities WHERE id=?').get(entityId)) throw new AppProblem('not_found', 'That entry is no longer in the list.')
      this.db.prepare('INSERT OR IGNORE INTO channels(id,entity_id,type,value,source,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), entityId, type, normalized, source, this.now())
      this.db.prepare('UPDATE entities SET updated_at=? WHERE id=?').run(this.now(), entityId)
    })
  }

  deleteChannel(id: string): void {
    this.write(() => { this.db.prepare('DELETE FROM channels WHERE id=?').run(id) })
  }

  /** Deleting a built-in organization is remembered, so it does not come back on the next launch. */
  deleteEntity(id: string): void {
    this.write(() => {
      const row = this.db.prepare('SELECT seed_key FROM entities WHERE id=?').get(id) as { seed_key: string | null } | undefined
      if (row?.seed_key) this.db.prepare('INSERT OR IGNORE INTO removed_seeds(seed_key) VALUES(?)').run(row.seed_key)
      this.db.prepare('DELETE FROM entities WHERE id=?').run(id)
    })
  }

  /** Records the user's answer about one sender. A later answer for the same sender replaces the earlier one. */
  decide(verdict: Verdict, claim: { claimedName: string; channelType: ChannelType; channelValue: string; entityId: string | null }, source: Provenance): void {
    TrustStore.vouched(source)
    const name = normalizeName(claim.claimedName).slice(0, 80)
    const value = normalizeChannel(claim.channelType, claim.channelValue)
    this.write(() => {
      this.db.prepare(`INSERT INTO decisions(id,verdict,claimed_name,channel_type,channel_value,entity_id,created_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(claimed_name,channel_type,channel_value) DO UPDATE SET verdict=excluded.verdict, entity_id=excluded.entity_id, created_at=excluded.created_at`)
        .run(randomUUID(), verdict, name, claim.channelType, value, claim.entityId, this.now())
    })
  }
  deleteDecision(id: string): void {
    this.write(() => { this.db.prepare('DELETE FROM decisions WHERE id=?').run(id) })
  }

  hasSeed(seedKey: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM entities WHERE seed_key=? UNION SELECT 1 FROM removed_seeds WHERE seed_key=?').get(seedKey, seedKey))
  }

  close(): void { this.db.close() }
}
