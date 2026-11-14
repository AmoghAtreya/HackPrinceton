import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SkillId } from '../../shared/skill-catalogue.ts'
import { isSkillId } from '../../shared/skill-catalogue.ts'
import type { Opportunity } from './bkt.ts'

export interface SkillState { p: number; opportunities: number; practice: boolean; updatedAt: number }
export interface SkillEvidence {
  userId: string; skillId: SkillId; opportunity: Opportunity; correct: boolean
  before: number; after: number; modelVersion: number; createdAt: number
}

/**
 * The per-skill estimates and the evidence behind them, in one local file.
 * An evidence row says which skill, what kind of chance, and whether it went
 * right. It never holds the question asked, the page visited or anything typed.
 */
export class SkillStore {
  private db: DatabaseSync
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    if (file !== ':memory:') chmodSync(file, 0o600)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        user_id TEXT NOT NULL, skill_id TEXT NOT NULL, p REAL NOT NULL CHECK(p > 0 AND p < 1),
        opportunities INTEGER NOT NULL DEFAULT 0, practice INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, skill_id)
      );
      CREATE TABLE IF NOT EXISTS evidence (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, skill_id TEXT NOT NULL,
        opportunity TEXT NOT NULL, correct INTEGER NOT NULL, p_before REAL NOT NULL, p_after REAL NOT NULL,
        model_version INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_user ON evidence(user_id, seq);
    `)
  }

  /** Saved states for a user. Rows for ids no longer in the catalogue are ignored, never guessed at. */
  states(userId: string): Map<SkillId, SkillState> {
    const rows = this.db.prepare('SELECT skill_id, p, opportunities, practice, updated_at FROM knowledge WHERE user_id = ?').all(userId) as Array<{
      skill_id: string; p: number; opportunities: number; practice: number; updated_at: number }>
    const states = new Map<SkillId, SkillState>()
    for (const row of rows) if (isSkillId(row.skill_id)) states.set(row.skill_id, { p: row.p, opportunities: row.opportunities, practice: row.practice === 1, updatedAt: row.updated_at })
    return states
  }

  record(evidence: SkillEvidence): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO knowledge(user_id, skill_id, p, opportunities, practice, updated_at) VALUES(?,?,?,1,0,?)
        ON CONFLICT(user_id, skill_id) DO UPDATE SET p = excluded.p, opportunities = opportunities + 1, updated_at = excluded.updated_at`)
        .run(evidence.userId, evidence.skillId, evidence.after, evidence.createdAt)
      this.db.prepare('INSERT INTO evidence(user_id, skill_id, opportunity, correct, p_before, p_after, model_version, created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(evidence.userId, evidence.skillId, evidence.opportunity, evidence.correct ? 1 : 0, evidence.before, evidence.after, evidence.modelVersion, evidence.createdAt)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  setPractice(userId: string, skillId: SkillId, practice: boolean, prior: number, now: number): void {
    this.db.prepare(`INSERT INTO knowledge(user_id, skill_id, p, opportunities, practice, updated_at) VALUES(?,?,?,0,?,?)
      ON CONFLICT(user_id, skill_id) DO UPDATE SET practice = excluded.practice, updated_at = excluded.updated_at`)
      .run(userId, skillId, prior, practice ? 1 : 0, now)
  }

  evidence(userId: string, limit = 200): SkillEvidence[] {
    const rows = this.db.prepare('SELECT * FROM evidence WHERE user_id = ? ORDER BY seq DESC LIMIT ?').all(userId, limit) as Array<Record<string, unknown>>
    return rows.filter((row) => isSkillId(row.skill_id)).map((row) => ({
      userId: row.user_id as string, skillId: row.skill_id as SkillId, opportunity: row.opportunity as Opportunity, correct: row.correct === 1,
      before: row.p_before as number, after: row.p_after as number, modelVersion: row.model_version as number, createdAt: row.created_at as number
    }))
  }

  close(): void { this.db.close() }
}
