import { z } from 'zod'
import { skillIds } from './skill-catalogue.ts'

// What the "What I've learned" view is given. There are no numbers here on
// purpose: the estimates never leave the main process, so no screen can show a score.

export type SkillStanding = 'known' | 'learning' | 'new'
export interface SkillSummary {
  id: string
  /** Plain words, starting with a verb: "attach a photo to an email". */
  name: string
  standing: SkillStanding
  /** A caregiver asked Triage to keep explaining this one. */
  practice: boolean
}
export interface SkillsView { skills: SkillSummary[] }

export const practiceSchema = z.object({ id: z.enum(skillIds as [string, ...string[]]), practice: z.boolean() }).strict()

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
export interface SkillsBridge {
  getSkills(): Promise<Result<SkillsView>>
  setSkillPractice(input: { id: string; practice: boolean }): Promise<Result<SkillsView>>
}
export const skillChannels = { view: 'skills:view', practice: 'skills:practice' } as const

/** The four numbers the page simplifier's learner gets about the skill a page calls for. All in 0..1. */
export interface SkillFeatures {
  /** How well the person knows the skill this kind of page needs. */
  page: number
  /** Their weakest prerequisite for it. */
  weakestPrerequisite: number
  /** Their average across the whole catalogue. */
  overall: number
  /** 1 when a caregiver marked the page's skill for practice. */
  practice: number
}
/** What the learner sees for someone Triage knows nothing about. */
export const neutralSkillFeatures: SkillFeatures = { page: 0.5, weakestPrerequisite: 0.5, overall: 0.5, practice: 0 }
