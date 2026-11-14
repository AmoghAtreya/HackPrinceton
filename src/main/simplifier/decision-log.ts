import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defaultTraits, pageTypes, type DecisionMode, type OutcomeSignals, type PageType, type UserTraits } from '../../shared/simplifier-contracts.ts'

/**
 * Every presentation decision is logged as
 *   (user_id, episode_id, step, x, a, p(a|x), r, timestamp)
 * plus the versions needed to interpret it later. This table is the training
 * set for anything after the hackathon: off-policy evaluation of new bandits,
 * offline RL (IQL/CQL) over episodes, or preference tuning of the planner.
 *
 * Privacy: only the page host is stored, never the full URL, page text,
 * screenshots or form contents.
 */

export interface DecisionRecord {
  userId: string
  episodeId: string
  step: number
  pageType: PageType
  pageHost: string
  featureVersion: number
  x: number[]
  armId: string
  propensity: number
  mode: DecisionMode
  policyName: string
  policyVersion: number
  viewSource: 'llm' | 'rules'
  sensitive: boolean
  voiceEnabled: boolean
}

export interface LoggedDecision extends DecisionRecord {
  id: string
  createdAt: number
  reward: number | null
  rewardVersion: number | null
  signals: OutcomeSignals | null
}

const rowSchema = z.object({
  id: z.string(), user_id: z.string(), episode_id: z.string(), step: z.number(), created_at: z.number(),
  page_type: z.enum(pageTypes), page_host: z.string(), feature_version: z.number(), x_json: z.string(),
  arm_id: z.string(), propensity: z.number(), mode: z.string(), policy_name: z.string(), policy_version: z.number(),
  view_source: z.enum(['llm', 'rules']), sensitive: z.number(), voice_enabled: z.number(),
  reward: z.number().nullable(), reward_version: z.number().nullable(), signals_json: z.string().nullable()
})

export class DecisionLog {
  private db: DatabaseSync

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    if (file !== ':memory:') chmodSync(file, 0o600)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, episode_id TEXT NOT NULL, step INTEGER NOT NULL,
        created_at INTEGER NOT NULL, page_type TEXT NOT NULL, page_host TEXT NOT NULL,
        feature_version INTEGER NOT NULL, x_json TEXT NOT NULL, arm_id TEXT NOT NULL,
        propensity REAL NOT NULL CHECK(propensity > 0 AND propensity <= 1), mode TEXT NOT NULL,
        policy_name TEXT NOT NULL, policy_version INTEGER NOT NULL, view_source TEXT NOT NULL,
        sensitive INTEGER NOT NULL, voice_enabled INTEGER NOT NULL,
        reward REAL, reward_version INTEGER, signals_json TEXT, rewarded_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS decisions_user ON decisions(user_id, created_at);
      CREATE INDEX IF NOT EXISTS decisions_episode ON decisions(episode_id, step);
      CREATE TABLE IF NOT EXISTS policy_state (name TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_traits (user_id TEXT PRIMARY KEY, traits_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `)
  }

  record(decision: DecisionRecord, now = Date.now()): string {
    const id = randomUUID()
    this.db.prepare(`INSERT INTO decisions (id, user_id, episode_id, step, created_at, page_type, page_host, feature_version, x_json,
      arm_id, propensity, mode, policy_name, policy_version, view_source, sensitive, voice_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, decision.userId, decision.episodeId, decision.step, now, decision.pageType, decision.pageHost, decision.featureVersion,
      JSON.stringify(decision.x), decision.armId, decision.propensity, decision.mode, decision.policyName, decision.policyVersion,
      decision.viewSource, decision.sensitive ? 1 : 0, decision.voiceEnabled ? 1 : 0)
    return id
  }

  /** Attach the reward. Returns false if the decision is unknown or already rewarded (rewards are write-once). */
  reward(id: string, reward: number, rewardVersion: number, signals: OutcomeSignals, now = Date.now()): boolean {
    const result = this.db.prepare('UPDATE decisions SET reward = ?, reward_version = ?, signals_json = ?, rewarded_at = ? WHERE id = ? AND reward IS NULL')
      .run(reward, rewardVersion, JSON.stringify(signals), now, id)
    return Number(result.changes) === 1
  }

  get(id: string): LoggedDecision | undefined {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id)
    return row ? this.decode(row) : undefined
  }

  /** Rewarded decisions, oldest first. The input for off-policy evaluation and offline training. */
  rewarded(options: { userId?: string; since?: number; limit?: number } = {}): LoggedDecision[] {
    const rows = this.db.prepare(`SELECT * FROM decisions WHERE reward IS NOT NULL
      AND (? IS NULL OR user_id = ?) AND created_at >= ? ORDER BY created_at, step LIMIT ?`)
      .all(options.userId ?? null, options.userId ?? null, options.since ?? 0, options.limit ?? 100000)
    return rows.map((row) => this.decode(row))
  }

  /** Decisions grouped into ordered episodes: the trajectory format offline RL needs. */
  episodes(options: { userId?: string; limit?: number } = {}): LoggedDecision[][] {
    const groups = new Map<string, LoggedDecision[]>()
    for (const decision of this.rewarded({ userId: options.userId, limit: options.limit })) {
      const list = groups.get(decision.episodeId) ?? []
      list.push(decision)
      groups.set(decision.episodeId, list)
    }
    return [...groups.values()].map((list) => list.sort((a, b) => a.step - b.step))
  }

  /** Recent share of low-reward outcomes for a user, used as the recent_error_rate feature. */
  recentErrorRate(userId: string, window = 20): number {
    const rows = this.db.prepare('SELECT reward FROM decisions WHERE user_id = ? AND reward IS NOT NULL ORDER BY created_at DESC LIMIT ?')
      .all(userId, window) as { reward: number }[]
    if (!rows.length) return 0
    return rows.filter((row) => row.reward < 0.4).length / rows.length
  }

  nextStep(episodeId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(step), -1) + 1 AS next FROM decisions WHERE episode_id = ?').get(episodeId) as { next: number }
    return row.next
  }

  savePolicy(name: string, state: string, now = Date.now()): void {
    this.db.prepare('INSERT INTO policy_state (name, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at')
      .run(name, state, now)
  }

  loadPolicy(name: string): string | undefined {
    const row = this.db.prepare('SELECT state FROM policy_state WHERE name = ?').get(name) as { state: string } | undefined
    return row?.state
  }

  traits(userId: string): UserTraits {
    const row = this.db.prepare('SELECT traits_json FROM user_traits WHERE user_id = ?').get(userId) as { traits_json: string } | undefined
    if (!row) return { ...defaultTraits }
    try { return { ...defaultTraits, ...(JSON.parse(row.traits_json) as Partial<UserTraits>) } } catch { return { ...defaultTraits } }
  }

  setTraits(userId: string, traits: Partial<UserTraits>, now = Date.now()): UserTraits {
    const merged = { ...this.traits(userId), ...traits }
    this.db.prepare('INSERT INTO user_traits (user_id, traits_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET traits_json = excluded.traits_json, updated_at = excluded.updated_at')
      .run(userId, JSON.stringify(merged), now)
    return merged
  }

  close(): void { this.db.close() }

  private decode(raw: unknown): LoggedDecision {
    const row = rowSchema.parse(raw)
    return {
      id: row.id, userId: row.user_id, episodeId: row.episode_id, step: row.step, createdAt: row.created_at,
      pageType: row.page_type, pageHost: row.page_host, featureVersion: row.feature_version,
      x: JSON.parse(row.x_json) as number[], armId: row.arm_id, propensity: row.propensity, mode: row.mode as DecisionMode,
      policyName: row.policy_name, policyVersion: row.policy_version, viewSource: row.view_source,
      sensitive: row.sensitive === 1, voiceEnabled: row.voice_enabled === 1,
      reward: row.reward, rewardVersion: row.reward_version,
      signals: row.signals_json ? (JSON.parse(row.signals_json) as OutcomeSignals) : null
    }
  }
}
