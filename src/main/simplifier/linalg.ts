// Tiny dense linear algebra for d ≈ 20. Matrices are row-major flat arrays.

export type Matrix = number[]

export function identity(d: number, scale = 1): Matrix {
  const m = new Array<number>(d * d).fill(0)
  for (let i = 0; i < d; i++) m[i * d + i] = scale
  return m
}

/** In place: m += scale · x xᵀ */
export function addOuter(m: Matrix, x: number[], scale = 1): void {
  const d = x.length
  for (let i = 0; i < d; i++) {
    const xi = x[i] * scale
    if (xi === 0) continue
    for (let j = 0; j < d; j++) m[i * d + j] += xi * x[j]
  }
}

export function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

/** Lower-triangular L with m = L Lᵀ. Adds jitter if m is numerically not positive definite. */
export function cholesky(m: Matrix, d: number): Matrix {
  const l = new Array<number>(d * d).fill(0)
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = m[i * d + j]
      for (let k = 0; k < j; k++) sum -= l[i * d + k] * l[j * d + k]
      if (i === j) l[i * d + i] = Math.sqrt(Math.max(sum, 1e-9))
      else l[i * d + j] = sum / l[j * d + j]
    }
  }
  return l
}

/** Solve L y = b (forward substitution). */
export function solveLower(l: Matrix, b: number[], d: number): number[] {
  const y = new Array<number>(d).fill(0)
  for (let i = 0; i < d; i++) {
    let sum = b[i]
    for (let k = 0; k < i; k++) sum -= l[i * d + k] * y[k]
    y[i] = sum / l[i * d + i]
  }
  return y
}

/** Solve Lᵀ x = y (back substitution). */
export function solveUpperT(l: Matrix, y: number[], d: number): number[] {
  const x = new Array<number>(d).fill(0)
  for (let i = d - 1; i >= 0; i--) {
    let sum = y[i]
    for (let k = i + 1; k < d; k++) sum -= l[k * d + i] * x[k]
    x[i] = sum / l[i * d + i]
  }
  return x
}

/** Solve (L Lᵀ) x = b. */
export function solveCholesky(l: Matrix, b: number[], d: number): number[] {
  return solveUpperT(l, solveLower(l, b, d), d)
}

export type Random = () => number

/** Standard normal via Box–Muller. */
export function gaussian(random: Random): number {
  let u = 0
  while (u === 0) u = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}

/** Deterministic PRNG (mulberry32) for reproducible simulations and tests. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Gamma(shape, 1) sample by Marsaglia & Tsang (2000), "A simple method for
 * generating gamma variables". Shapes below 1 use the boost
 * Gamma(a) = Gamma(a + 1) · U^(1/a).
 */
export function gammaSample(shape: number, random: Random): number {
  if (!(shape > 0)) throw new Error('Gamma shape must be positive')
  if (shape < 1) {
    let u = 0
    while (u === 0) u = random()
    return gammaSample(shape + 1, random) * Math.pow(u, 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do { x = gaussian(random); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    let u = 0
    while (u === 0) u = random()
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

/** σ² ~ Inverse-Gamma(shape, scale), as scale / Gamma(shape, 1). */
export function inverseGammaSample(shape: number, scale: number, random: Random): number {
  return scale / gammaSample(shape, random)
}
