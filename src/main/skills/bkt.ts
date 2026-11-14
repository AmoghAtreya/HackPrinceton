// ---------------------------------------------------------------------------
// Bayesian Knowledge Tracing.
//
// Each skill has a hidden state, known or not known, and Triage keeps the
// probability P(L) that it is known. Each time the person has a chance to use
// the skill, P(L) is updated in two steps (Corbett & Anderson, 1995):
//
//   1. Evidence. With slip s = P(wrong | known) and guess g = P(right | not known):
//        right:  P(L | obs) = P(L)(1-s) / [ P(L)(1-s) + (1-P(L)) g ]
//        wrong:  P(L | obs) = P(L) s    / [ P(L) s     + (1-P(L))(1-g) ]
//   2. Learning. The chance itself may have taught them:
//        P(L) <- P(L | obs) + (1 - P(L | obs)) * t
//
// The one extension to textbook BKT: slip and guess depend on the KIND of
// opportunity, because the kinds differ in how much they prove. Clicking a
// control Triage has just outlined is easy to get right without knowing how
// (high guess); finishing a task alone is not (low guess).
// ---------------------------------------------------------------------------

/** Bump when any number below changes; it is logged with every update so records stay interpretable. */
export const BKT_VERSION = 1

export const opportunities = ['unaided', 'pointed', 'asked', 'implied'] as const
export type Opportunity = typeof opportunities[number]

export interface OpportunityModel { slip: number; guess: number; learn: number }

export const OPPORTUNITY: Record<Opportunity, OpportunityModel> = {
  /** Did the task without Triage showing the way. Right = finished. Wrong = stuck, went back, or had to repeat. */
  unaided: { slip: 0.1, guess: 0.15, learn: 0.1 },
  /** Triage outlined the control. Right = clicked it first try. Wrong = never clicked it, or it was lost. */
  pointed: { slip: 0.1, guess: 0.55, learn: 0.2 },
  /** A chance to do it from memory. Asking how is the "wrong" outcome: people who know rarely ask. */
  asked: { slip: 0.15, guess: 0.3, learn: 0.1 },
  /** A harder skill was just done right, which is not possible without this one. Only ever "right". */
  implied: { slip: 0.05, guess: 0.5, learn: 0 }
}

const clamp = (p: number) => Math.min(0.999, Math.max(0.001, Number.isFinite(p) ? p : 0.5))

/** Step 1 only: belief after seeing the outcome, before any learning. */
export function posterior(p: number, correct: boolean, model: OpportunityModel): number {
  const prior = clamp(p)
  const known = prior * (correct ? 1 - model.slip : model.slip)
  const unknown = (1 - prior) * (correct ? model.guess : 1 - model.guess)
  return clamp(known / (known + unknown))
}

/** Both steps: the new P(L) after one opportunity. */
export function update(p: number, correct: boolean, opportunity: Opportunity): number {
  const model = OPPORTUNITY[opportunity]
  const after = posterior(p, correct, model)
  return clamp(after + (1 - after) * model.learn)
}

/** At or above this, Triage treats a skill as known and stops explaining it. */
export const MASTERED = 0.85
/** Below this, a skill counts as not yet learned rather than in progress. */
export const LEARNING = 0.45

export type SkillLevel = 'known' | 'learning' | 'new'
export function levelOf(p: number): SkillLevel { return p >= MASTERED ? 'known' : p >= LEARNING ? 'learning' : 'new' }
