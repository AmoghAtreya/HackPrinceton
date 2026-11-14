import type { PageType } from '../../shared/simplifier-contracts.ts'
import { ARMS, DEFAULT_ARM_ID } from './arms.ts'
import { FEATURE_DIM, FEATURE_VERSION } from './features.ts'
import { addOuter, cholesky, dot, gaussian, identity, solveCholesky, solveUpperT, type Matrix, type Random } from './linalg.ts'
import type { PolicyDecision, PolicyInput, PresentationPolicy } from './policy.ts'

/**
 * Hierarchical Bayesian linear Thompson Sampling, one linear model per arm.
 *
 *   reward ≈ θ_{u,a} · x
 *
 * Population level (shared by everyone): θ_a ~ N(m0_a, (1/λ_pop) I), updated
 * with every user's data. User level: θ_{u,a} ~ N(population mean of θ_a,
 * (1/λ_user) I), updated with that user's data only. A new user therefore
 * starts at what works for people in general and drifts toward their own
 * preferences, instead of seeing random layouts.
 *
 * Only sufficient statistics (XᵀX, Xᵀr, n) are stored, so the population mean
 * can keep improving and every user's posterior picks that up at decision time.
 *
 * Approximation: the population statistics include each user's own data, which
 * that user's posterior then counts again. With many users the effect is small;
 * a leave-one-out population mean is the exact fix if it ever matters.
 */

export interface ThompsonOptions {
  /** Prior precision for the population model. Higher = trust prior longer. */
  populationPrecision: number
  /** Prior precision pulling a user toward the population mean. */
  userPrecision: number
  /** Observation noise variance σ² of rewards. */
  noise: number
  /** Posterior sample scale v (≤ 1 tightens exploration; doc: keep exploration conservative). */
  explorationScale: number
  /** Monte Carlo draws used to estimate propensities and confidence. */
  propensitySamples: number
  /**
   * Cold start: until a user has this many observations for a page type, show
   * the best estimate (population mean, or the default arm) instead of a random
   * draw. With an uninformed prior, sampling noise swamps the default arm's
   * head start, so without this new users would see random layouts.
   */
  warmup: number
  /** Freeze a (user, page type) once it has this many observations... */
  freezeAfter: number
  /** ...and the best arm wins at least this share of posterior samples. */
  freezeConfidence: number
}

export const DEFAULT_THOMPSON_OPTIONS: ThompsonOptions = {
  populationPrecision: 4, userPrecision: 8, noise: 0.05, explorationScale: 0.5,
  propensitySamples: 200, warmup: 3, freezeAfter: 25, freezeConfidence: 0.9
}

interface Stats { xtx: number[]; xtr: number[]; n: number }
interface UserState { arms: Record<string, Stats>; counts: Partial<Record<PageType, number>>; frozen: Partial<Record<PageType, string>> }
interface SerializedState { name: 'thompson'; version: number; featureVersion: number; dim: number; population: Record<string, Stats>; users: Record<string, UserState> }

const emptyStats = (d: number): Stats => ({ xtx: new Array<number>(d * d).fill(0), xtr: new Array<number>(d).fill(0), n: 0 })

/** Prior mean: neutral reward 0.5 on the bias term, a small head start for the default arm. */
function priorMean(armId: string, d: number): number[] {
  const m = new Array<number>(d).fill(0)
  m[0] = armId === DEFAULT_ARM_ID ? 0.55 : 0.5
  return m
}

interface Posterior { mean: number[]; chol: Matrix }

export class ThompsonPolicy implements PresentationPolicy {
  readonly name = 'thompson'
  readonly version = 1
  private readonly d = FEATURE_DIM
  private readonly options: ThompsonOptions
  private readonly random: Random
  private population: Record<string, Stats> = {}
  private users: Record<string, UserState> = {}

  constructor(options: Partial<ThompsonOptions> = {}, random: Random = Math.random, serialized?: string) {
    this.options = { ...DEFAULT_THOMPSON_OPTIONS, ...options }
    this.random = random
    if (serialized) this.restore(serialized)
  }

  // ---- posterior maths -----------------------------------------------------

  private populationMean(armId: string): number[] {
    const d = this.d
    const stats = this.population[armId] ?? emptyStats(d)
    const precision = identity(d, this.options.populationPrecision)
    for (let i = 0; i < d * d; i++) precision[i] += stats.xtx[i] / this.options.noise
    const m0 = priorMean(armId, d)
    const rhs = m0.map((value, i) => this.options.populationPrecision * value + stats.xtr[i] / this.options.noise)
    return solveCholesky(cholesky(precision, d), rhs, d)
  }

  private posterior(userId: string, armId: string): Posterior {
    const d = this.d
    const stats = this.users[userId]?.arms[armId] ?? emptyStats(d)
    const prior = this.populationMean(armId)
    const precision = identity(d, this.options.userPrecision)
    for (let i = 0; i < d * d; i++) precision[i] += stats.xtx[i] / this.options.noise
    const rhs = prior.map((value, i) => this.options.userPrecision * value + stats.xtr[i] / this.options.noise)
    const chol = cholesky(precision, d)
    return { mean: solveCholesky(chol, rhs, d), chol }
  }

  /** One draw θ ~ N(mean, v² · precision⁻¹), scored against x. */
  private sampleScore(post: Posterior, x: number[]): number {
    const z = Array.from({ length: this.d }, () => gaussian(this.random))
    const noise = solveUpperT(post.chol, z, this.d)
    let score = 0
    for (let i = 0; i < this.d; i++) score += (post.mean[i] + this.options.explorationScale * noise[i]) * x[i]
    return score
  }

  /** Share of posterior draws each arm wins. Doubles as propensity and confidence. */
  private winShares(input: PolicyInput): Map<string, number> {
    const posts = input.arms.map((arm) => [arm.id, this.posterior(input.userId, arm.id)] as const)
    const wins = new Map<string, number>(input.arms.map((arm) => [arm.id, 0]))
    const draws = this.options.propensitySamples
    for (let s = 0; s < draws; s++) {
      let best = posts[0][0]
      let bestScore = -Infinity
      for (const [id, post] of posts) {
        const score = this.sampleScore(post, input.x)
        if (score > bestScore) { bestScore = score; best = id }
      }
      wins.set(best, wins.get(best)! + 1)
    }
    for (const [id, count] of wins) wins.set(id, count / draws)
    return wins
  }

  private greedy(input: PolicyInput): string {
    let best = input.arms[0].id
    let bestScore = -Infinity
    for (const arm of input.arms) {
      const score = dot(this.posterior(input.userId, arm.id).mean, input.x)
      if (score > bestScore) { bestScore = score; best = arm.id }
    }
    return best
  }

  // ---- PresentationPolicy --------------------------------------------------

  choose(input: PolicyInput): PolicyDecision {
    const allowed = new Set(input.arms.map((arm) => arm.id))
    const frozen = this.users[input.userId]?.frozen[input.pageType]
    if (frozen && allowed.has(frozen)) return { armId: frozen, propensity: 1, mode: 'frozen' }
    if (input.sensitive) return { armId: this.greedy(input), propensity: 1, mode: 'shielded' }
    if (this.warmingUp(input)) return { armId: this.greedy(input), propensity: 1, mode: 'exploit' }

    const shares = this.winShares(input)
    // The live choice is one fresh Thompson draw per arm; its propensity is the
    // Monte Carlo estimate of how often that arm wins, floored to stay > 0.
    const posts = input.arms.map((arm) => [arm.id, this.posterior(input.userId, arm.id)] as const)
    let armId = posts[0][0]
    let bestScore = -Infinity
    for (const [id, post] of posts) {
      const score = this.sampleScore(post, input.x)
      if (score > bestScore) { bestScore = score; armId = id }
    }
    const floor = 1 / (2 * this.options.propensitySamples)
    const propensity = Math.max(shares.get(armId) ?? 0, floor)
    const leader = [...shares.entries()].sort((a, b) => b[1] - a[1])[0]
    this.maybeFreeze(input, leader[0], leader[1])
    return { armId, propensity, mode: leader[0] === armId ? 'exploit' : 'explore' }
  }

  probability(input: PolicyInput, armId: string): number {
    const frozen = this.users[input.userId]?.frozen[input.pageType]
    if (frozen && input.arms.some((arm) => arm.id === frozen)) return frozen === armId ? 1 : 0
    if (input.sensitive || this.warmingUp(input)) return this.greedy(input) === armId ? 1 : 0
    return this.winShares(input).get(armId) ?? 0
  }

  learn(input: PolicyInput, armId: string, reward: number): void {
    if (!ARMS.some((arm) => arm.id === armId)) return
    if (input.x.length !== this.d || !Number.isFinite(reward)) return
    const r = Math.max(0, Math.min(1, reward))
    const user = (this.users[input.userId] ??= { arms: {}, counts: {}, frozen: {} })
    for (const stats of [(this.population[armId] ??= emptyStats(this.d)), (user.arms[armId] ??= emptyStats(this.d))]) {
      addOuter(stats.xtx, input.x)
      for (let i = 0; i < this.d; i++) stats.xtr[i] += input.x[i] * r
      stats.n++
    }
    user.counts[input.pageType] = (user.counts[input.pageType] ?? 0) + 1
  }

  private warmingUp(input: PolicyInput): boolean {
    return (this.users[input.userId]?.counts[input.pageType] ?? 0) < this.options.warmup
  }

  /** Stability rule from the doc: once confident on a page type, stop reshuffling the layout. */
  private maybeFreeze(input: PolicyInput, leader: string, share: number): void {
    const user = this.users[input.userId]
    if (!user || user.frozen[input.pageType]) return
    if ((user.counts[input.pageType] ?? 0) >= this.options.freezeAfter && share >= this.options.freezeConfidence) {
      user.frozen[input.pageType] = leader
    }
  }

  /** Explicit reset, e.g. the user says "show it to me differently". */
  unfreeze(userId: string, pageType?: PageType): void {
    const user = this.users[userId]
    if (!user) return
    if (pageType) delete user.frozen[pageType]
    else user.frozen = {}
  }

  frozenArms(userId: string): Partial<Record<PageType, string>> {
    return { ...(this.users[userId]?.frozen ?? {}) }
  }

  serialize(): string {
    const state: SerializedState = { name: 'thompson', version: this.version, featureVersion: FEATURE_VERSION, dim: this.d, population: this.population, users: this.users }
    return JSON.stringify(state)
  }

  private restore(serialized: string): void {
    const state = JSON.parse(serialized) as Partial<SerializedState>
    // A different feature layout makes the old statistics meaningless. Start
    // fresh; the decision log still holds every observation for re-training.
    if (state.name !== 'thompson' || state.featureVersion !== FEATURE_VERSION || state.dim !== this.d) return
    this.population = state.population ?? {}
    this.users = state.users ?? {}
  }
}
