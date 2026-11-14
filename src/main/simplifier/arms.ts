import type { PresentationArm } from '../../shared/simplifier-contracts.ts'

/**
 * The pruned arm catalogue (design doc: "keep to 6–12, prune nonsense combos").
 * Pruned out: 2x font with 6 actions (does not fit a screen), and voice
 * narration with step-by-step verbosity on small fonts (too slow for users who
 * do not need large text).
 *
 * IDs are written into the decision log. Never rename, reorder-in-meaning or
 * reuse an ID; retire arms by removing them and add new ones with new IDs.
 */
export const ARMS: readonly PresentationArm[] = Object.freeze([
  { id: 'a01', fontScale: 1.25, maxActions: 6, plainLanguage: false, voiceNarration: false, verbosity: 'terse' },
  { id: 'a02', fontScale: 1.25, maxActions: 6, plainLanguage: true, voiceNarration: false, verbosity: 'terse' },
  { id: 'a03', fontScale: 1.25, maxActions: 3, plainLanguage: true, voiceNarration: true, verbosity: 'terse' },
  { id: 'a04', fontScale: 1.5, maxActions: 6, plainLanguage: false, voiceNarration: false, verbosity: 'terse' },
  { id: 'a05', fontScale: 1.5, maxActions: 6, plainLanguage: true, voiceNarration: false, verbosity: 'step_by_step' },
  { id: 'a06', fontScale: 1.5, maxActions: 3, plainLanguage: true, voiceNarration: false, verbosity: 'terse' },
  { id: 'a07', fontScale: 1.5, maxActions: 3, plainLanguage: true, voiceNarration: true, verbosity: 'step_by_step' },
  { id: 'a08', fontScale: 2, maxActions: 3, plainLanguage: false, voiceNarration: false, verbosity: 'terse' },
  { id: 'a09', fontScale: 2, maxActions: 3, plainLanguage: true, voiceNarration: false, verbosity: 'step_by_step' },
  { id: 'a10', fontScale: 2, maxActions: 3, plainLanguage: true, voiceNarration: true, verbosity: 'step_by_step' }
] satisfies PresentationArm[])

/** The safe default used by the rules policy and when nothing has been learned yet. */
export const DEFAULT_ARM_ID = 'a06'

export function armById(id: string): PresentationArm {
  const arm = ARMS.find((candidate) => candidate.id === id)
  if (!arm) throw new Error('Unknown presentation arm: ' + id)
  return arm
}

/**
 * Action shielding: arms the policy may pick in this context. Voice arms are
 * only allowed when the session has voice turned on. The learner can never
 * pick anything outside this list, and arms never trigger clicks or submits.
 */
export function allowedArms(voiceEnabled: boolean): PresentationArm[] {
  return ARMS.filter((arm) => voiceEnabled || !arm.voiceNarration)
}
