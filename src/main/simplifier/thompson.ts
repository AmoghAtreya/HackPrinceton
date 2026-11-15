import type { PageType } from '../../shared/simplifier-contracts.ts'
import { ARMS, DEFAULT_ARM_ID } from './arms.ts'
import { FEATURE_DIM, FEATURE_VERSION } from './features.ts'
import { addOuter, cholesky, dot, gaussian, identity, inverseGammaSample, solveCholesky, solveUpperT, type Matrix, type Random } from './linalg.ts'
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
 *
 * Research-based refinements (v2):
 *
 * 1. Unknown noise (Normal-Inverse-Gamma posterior). The reward noise σ² is
 *    learned per user and arm instead of fixed: σ² ~ InvGamma(a_n, b_n), then
 *    θ ~ N(μ_n, σ² Λ_n⁻¹). Riquelme, Tucker & Snoek (ICLR 2018, "Deep Bayesian
 *    Bandits Showdown") found this linear full-posterior sampler among the most
 *    robust bandits across tasks. A person whose ratings are consistent gets
 *    tighter posteriors (less exploration); an inconsistent one gets wider.
 *
 * 2. Discounting for drifting preferences. Each time a user rates a page,
 *    that user's statistics are multiplied by γ before the new rating is added,
 *    so a rating t steps ago has weight γᵗ (Russac, Vernade & Cappé, NeurIPS
 *    2019, D-LinUCB; Raj & Kalyani 2017, discounted Thompson sampling). With
 *    γ = 0.98 the effective memory is ~50 ratings: needs that change (eyesight,
 *    fatigue, growing confidence) are followed instead of averaged away. The
 *    population model is not discounted: what works for people in general
 *    changes slowly.
 *
 * 3. Narrower sampling (v = 0.5). Chapelle & Li (NeurIPS 2011, "An empirical
 *    evaluation of Thompson sampling") found scaling the posterior down improves
 *    early performance; for older adults it also limits layout reshuffling.
 *
 * 4. Posterior caching. Each (user, arm) posterior is factorised once and
 *    reused across the Monte Carlo draws until the next rating arrives.
 */

export interface ThompsonOptions {
  /** Prior precision λ for the population model, in units of the noise (prior cov = σ²/λ · I). */
  populationPrecision: number
  /** Prior precision λ pulling a user toward the population mean, in units of the noise. */
  userPrecision: number
  /** Inverse-Gamma prior on the reward noise σ²: shape a0 and scale b0 (prior mean b0 / (a0 − 1)). */
  noiseShape: number
  noiseScale: number
  /** Per-rating discount γ on a user's statistics (1 = never forget). */
  discount: number
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
  // λ values reproduce v1's posterior means (v1 used precision λ/σ² with σ² = 0.05);
  // the noise prior is centred on that same σ² = 0.1 / (3 − 1) = 0.05.
  populationPrecision: 0.2, userPrecision: 0.4, noiseShape: 3, noiseScale: 0.1, discount: 0.98, explorationScale: 0.5,
  propensitySamples: 200, warmup: 3, freezeAfter: 25, freezeConfidence: 0.9
}

/** Sufficient statistics (discounted for users): XᵀX, Xᵀr, Σr² and the effective count. */
interface Stats { xtx: number[]; xtr: number[]; n: number; yy?: number }
interface UserState { arms: Record<string, Stats>; counts: Partial<Record<PageType, number>>; frozen: Partial<Record<PageType, string>> }
interface SerializedState { name: 'thompson'; version: number; featureVersion: number; dim: number; population: Record<string, Stats>; users: Record<string, UserState> }

const emptyStats = (d: number): Stats => ({ xtx: new Array<number>(d * d).fill(0), xtr: new Array<number>(d).fill(0), n: 0, yy: 0 })

/** Prior mean: neutral reward 0.5 on the bias term, a small head start for the default arm. */
function priorMean(armId: string, d: number): number[] {
  const m = new Array<number>(d).fill(0)
  m[0] = armId === DEFAULT_ARM_ID ? 0.55 : 0.5
  return m
}

/** μ_n, the Cholesky factor of Λ_n, and the Inverse-Gamma (a_n, b_n) for σ². */
interface Posterior { mean: number[]; chol: Matrix; shape: number; scale: number }

export interface ArmDiagnostics { noiseVariance: number; evidence: number }

export class ThompsonPolicy implements PresentationPolicy {
  readonly name = 'thompson'
  readonly version = 2
  private readonly d = FEATURE_DIM
  private readonly options: ThompsonOptions
  private readonly random: Random
  private population: Record<string, Stats> = {}
  private users: Record<string, UserState> = {}
  private readonly cache = new Map<string, Posterior>()
  private readonly populationCache = new Map<string, number[]>()

  constructor(options: Partial<ThompsonOptions> = {}, random: Random = Math.random, serialized?: string) {
    this.options = { ...DEFAULT_THOMPSON_OPTIONS, ...options }
    this.random = random
    if (serialized) this.restore(serialized)
  }

  // ---- posterior maths -----------------------------------------------------

  private populationMean(armId: string): number[] {
    const cached = this.populationCache.get(armId)
    if (cached) return cached
    const d = this.d
    const stats = this.population[armId] ?? emptyStats(d)
    const lambda = this.options.populationPrecision
    const precision = identity(d, lambda)
    for (let i = 0; i < d * d; i++) precision[i] += stats.xtx[i]
    const rhs = priorMean(armId, d).map((value, i) => lambda * value + stats.xtr[i])
    const mean = solveCholesky(cholesky(precision, d), rhs, d)
    this.populationCache.set(armId, mean)
    return mean
  }

  /**
   * Normal-Inverse-Gamma posterior for one user and arm, with the population
   * mean as the prior mean m0 and prior precision Λ0 = λ_user · I:
   *   Λ_n = Λ0 + XᵀX,  μ_n = Λ_n⁻¹(Λ0 m0 + Xᵀr)
   *   a_n = a0 + n/2,  b_n = b0 + ½(Σr² + m0ᵀΛ0 m0 − μ_nᵀ Λ_n μ_n)
   */
  private posterior(userId: string, armId: string): Posterior {
    const key = userId + '|' + armId
    const cached = this.cache.get(key)
    if (cached) return cached
    const d = this.d
    const stats = this.users[userId]?.arms[armId] ?? emptyStats(d)
    const m0 = this.populationMean(armId)
    const lambda = this.options.userPrecision
    const precision = identity(d, lambda)
    for (let i = 0; i < d * d; i++) precision[i] += stats.xtx[i]
    const rhs = m0.map((value, i) => lambda * value + stats.xtr[i])
    const chol = cholesky(precision, d)
    const mean = solveCholesky(chol, rhs, d)
    let quadratic = 0
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) quadratic += mean[i] * precision[i * d + j] * mean[j]
    const shape = this.options.noiseShape + stats.n / 2
    // Floored: rounding (or v1 states without Σr²) must never give a non-positive scale.
    const scale = Math.max(this.options.noiseScale * 0.1, this.options.noiseScale + 0.5 * ((stats.yy ?? 0) + lambda * dot(m0, m0) - quadratic))
    const post = { mean, chol, shape, scale }
    this.cache.set(key, post)
    return post
  }

  /** One draw σ² ~ InvGamma(a_n, b_n), θ ~ N(μ_n, v² σ² Λ_n⁻¹), scored against x. */
  private sampleScore(post: Posterior, x: number[]): number {
    const sigma = Math.sqrt(inverseGammaSample(post.shape, post.scale, this.random))
    const z = Array.from({ length: this.d }, () => gaussian(this.random))
    const noise = solveUpperT(post.chol, z, this.d)
    let score = 0
    for (let i = 0; i < this.d; i++) score += (post.mean[i] + this.options.explorationScale * sigma * noise[i]) * x[i]
    return score
  }

  /** Learned noise E[σ²] and effective (discounted) number of ratings per arm, for the learning monitor. */
  diagnostics(userId: string, armIds: string[]): Record<string, ArmDiagnostics> {
    return Object.fromEntries(armIds.map((armId) => {
      const post = this.posterior(userId, armId)
      return [armId, { noiseVariance: post.scale / Math.max(post.shape - 1, 1e-6), evidence: this.users[userId]?.arms[armId]?.n ?? 0 }]
    }))
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
    // Discount this user's past ratings on every arm, then add the new one.
    const gamma = this.options.discount
    if (gamma < 1) for (const stats of Object.values(user.arms)) {
      for (let i = 0; i < stats.xtx.length; i++) stats.xtx[i] *= gamma
      for (let i = 0; i < stats.xtr.length; i++) stats.xtr[i] *= gamma
      stats.yy = (stats.yy ?? 0) * gamma
      stats.n *= gamma
    }
    for (const stats of [(this.population[armId] ??= emptyStats(this.d)), (user.arms[armId] ??= emptyStats(this.d))]) {
      addOuter(stats.xtx, input.x)
      for (let i = 0; i < this.d; i++) stats.xtr[i] += input.x[i] * r
      stats.yy = (stats.yy ?? 0) + r * r
      stats.n++
    }
    this.cache.clear()
    this.populationCache.delete(armId)
    user.counts[input.pageType] = (user.counts[input.pageType] ?? 0) + 1
  }

  private warmingUp(input: PolicyInput): boolean {
    return (this.users[input.userId]?.counts[input.pageType] ?? 0) < this.options.warmup
  }

  odds(input: PolicyInput): Record<string, number> {
    const frozen = this.users[input.userId]?.frozen[input.pageType]
    if ((frozen && input.arms.some((arm) => arm.id === frozen)) || input.sensitive || this.warmingUp(input)) {
      const chosen = frozen && input.arms.some((arm) => arm.id === frozen) ? frozen : this.greedy(input)
      return Object.fromEntries(input.arms.map((arm) => [arm.id, arm.id === chosen ? 1 : 0]))
    }
    return Object.fromEntries(this.winShares(input))
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
    this.cache.clear()
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
    // v1 states have no Σr²; the scale floor in posterior() keeps them valid.
    this.cache.clear()
    this.populationCache.clear()
  }
}
