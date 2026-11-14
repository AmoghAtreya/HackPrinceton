import { catalogueOnly, isSkillId, prerequisitesOf, skill, skills, type SkillId } from '../../shared/skill-catalogue.ts'
import { practiceSchema, type SkillFeatures, type SkillsView } from '../../shared/skill-contracts.ts'
import type { OutcomeSignals, PageType } from '../../shared/simplifier-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { BKT_VERSION, LEARNING, MASTERED, levelOf, update, type Opportunity } from './bkt.ts'
import type { SkillStore } from './store.ts'

export const TEACHING_PLAN_TAG = 'teaching_plan'
/** How long a how-to question stays "what they are working on", so a later highlight click counts toward it. */
const RECENT_MS = 10 * 60 * 1000
/** At most this many steps are spelled out; the ones closest to the goal win. */
const MAX_EXPLAINED = 4

/** The skill each kind of page calls for, for the simplifier's learner and its outcomes. */
export const PAGE_SKILL: Record<PageType, SkillId> = {
  login: 'sign_in', checkout: 'pay_online', form: 'fill_form', email: 'read_email', article: 'scroll', other: 'find_button'
}

export interface TeachingPlan {
  targets: SkillId[]
  /** Explain these, in this order: missing prerequisites first, then what was asked. */
  explain: SkillId[]
  /** In progress: a few words at most. */
  remind: SkillId[]
  /** Leave these out. */
  known: SkillId[]
  /** A caregiver asked for these to be walked through regardless. */
  practice: SkillId[]
}

/**
 * Turns what the person does into per-skill estimates (Bayesian Knowledge
 * Tracing, see bkt.ts) and turns the estimates into teaching instructions.
 * The numbers stay in here: plans, guidance and the view carry words only.
 */
export class SkillTutor {
  private store: SkillStore
  private now: () => number
  private recent = new Map<string, { skills: SkillId[]; at: number }>()
  private pointing = new Map<string, { userId: string; conversationId: string; skills: SkillId[] }>()

  constructor(store: SkillStore, now: () => number = Date.now) { this.store = store; this.now = now }

  private knowledge(userId: string): { p: (id: SkillId) => number; practice: (id: SkillId) => boolean } {
    const states = this.store.states(userId)
    return { p: (id) => states.get(id)?.p ?? skill(id).prior, practice: (id) => states.get(id)?.practice ?? false }
  }

  /** One opportunity for each skill. A real success also counts, more weakly, for everything those skills build on. */
  observe(userId: string, ids: readonly SkillId[], opportunity: Opportunity, correct: boolean): void {
    const { p } = this.knowledge(userId)
    const apply = (id: SkillId, kind: Opportunity, right: boolean): void => {
      const before = p(id)
      this.store.record({ userId, skillId: id, opportunity: kind, correct: right, before, after: update(before, right, kind), modelVersion: BKT_VERSION, createdAt: this.now() })
    }
    const direct = [...new Set(ids)].filter(isSkillId)
    for (const id of direct) apply(id, opportunity, correct)
    if (!correct || opportunity === 'asked' || opportunity === 'implied') return
    const implied = new Set<SkillId>()
    for (const id of direct) for (const needed of prerequisitesOf(id)) if (!direct.includes(needed)) implied.add(needed)
    for (const id of implied) apply(id, 'implied', true)
  }

  plan(userId: string, requested: readonly unknown[]): TeachingPlan | undefined {
    const targets = catalogueOnly(requested)
    if (!targets.length) return undefined
    const { p, practice } = this.knowledge(userId)
    const chain: SkillId[] = []
    for (const target of targets) for (const id of [...prerequisitesOf(target), target]) if (!chain.includes(id)) chain.push(id)
    const marked = chain.filter(practice)
    // What was asked is always answered; a prerequisite is spelled out only when it is missing or marked.
    const explain = chain.filter((id) => targets.includes(id) || marked.includes(id) || p(id) < LEARNING).slice(-MAX_EXPLAINED)
    const remind = chain.filter((id) => !explain.includes(id) && p(id) < MASTERED)
    const known = chain.filter((id) => !explain.includes(id) && !remind.includes(id))
    return { targets, explain, remind, known, practice: marked }
  }

  /** Instructions for the model on how to answer a how-to. Words only: no estimate appears in it. */
  guidance(userId: string, requested: readonly unknown[]): string | undefined {
    const plan = this.plan(userId, requested)
    if (!plan) return undefined
    const names = (ids: SkillId[]) => ids.map((id) => skill(id).name).join('; ')
    return [`<${TEACHING_PLAN_TAG}>`,
      'Triage’s own record of what this person can already do. Trusted. Use it to shape your answer. Never mention this record, and never give a score, a level or a judgement of how much they know.',
      `They are asking how to: ${names(plan.targets)}.`,
      ...(plan.known.length ? [`They already do these comfortably, so leave them out: ${names(plan.known)}.`] : []),
      ...(plan.remind.length ? [`They are getting used to these; a few words at most: ${names(plan.remind)}.`] : []),
      `Explain these, in this order, one short step at a time: ${names(plan.explain)}.`,
      ...(plan.practice.length ? [`A caregiver asked for extra practice on: ${names(plan.practice)}. Walk through it fully and kindly, even if it seems simple.`] : []),
      `</${TEACHING_PLAN_TAG}>`].join('\n')
  }

  /** How much to say when pointing at a control, given how used the person is to finding controls. */
  locateGuidance(userId: string, conversationId: string): string {
    const { p, practice } = this.knowledge(userId)
    const working = this.working(conversationId)
    const used = p('find_button') >= MASTERED && !practice('find_button') && working.every((id) => p(id) >= LEARNING && !practice(id))
    return [`<${TEACHING_PLAN_TAG}>`,
      'Triage’s own record of what this person can already do. Trusted. Never mention it or any score.',
      used ? 'They find controls on a page comfortably. Keep the explanation to one short sentence naming the control.'
        : 'They are still learning to find controls on a page. In the explanation say where it is (top, bottom, left or right), what it looks like, and what will happen when they press it.',
      `</${TEACHING_PLAN_TAG}>`].join('\n')
  }

  private working(conversationId: string): SkillId[] {
    const entry = this.recent.get(conversationId)
    return entry && this.now() - entry.at <= RECENT_MS ? entry.skills : []
  }

  /** The person asked how to do something: evidence that they could not do it from memory. */
  asked(userId: string, conversationId: string, requested: readonly unknown[]): SkillId[] {
    const targets = catalogueOnly(requested)
    if (!targets.length) return targets
    this.observe(userId, targets, 'asked', false)
    this.recent.set(conversationId, { skills: targets, at: this.now() })
    return targets
  }

  /** Triage is now pointing at a control for this task. Asking again before clicking the last one means that one did not work. */
  pointed(userId: string, conversationId: string, taskId: string): void {
    for (const [earlier, entry] of this.pointing) if (entry.conversationId === conversationId) this.resolved(earlier, false)
    this.pointing.set(taskId, { userId, conversationId, skills: [...new Set<SkillId>(['find_button', ...this.working(conversationId)])] })
  }
  /** The pointed-at control was clicked first try (true), or it was lost or abandoned (false). Unknown tasks are ignored. */
  resolved(taskId: string, clicked: boolean): void {
    const entry = this.pointing.get(taskId)
    if (!entry) return
    this.pointing.delete(taskId)
    this.observe(entry.userId, entry.skills, 'pointed', clicked)
  }

  /** What happened on a simplified page, as evidence about the skill that kind of page needs. */
  observePage(userId: string, pageType: PageType, signals: Pick<OutcomeSignals, 'taskCompleted' | 'backtracks' | 'repeatRequests'>): void {
    const id = PAGE_SKILL[pageType]
    if (signals.taskCompleted) this.observe(userId, [id], 'pointed', true)
    if (signals.backtracks > 0 || signals.repeatRequests > 0) this.observe(userId, [id], 'unaided', false)
  }

  /** What the page simplifier's learner is told about this person for this kind of page. */
  features(userId: string, pageType: PageType): SkillFeatures {
    const { p, practice } = this.knowledge(userId)
    const id = PAGE_SKILL[pageType]
    const needed = prerequisitesOf(id)
    return {
      page: p(id), weakestPrerequisite: needed.length ? Math.min(...needed.map(p)) : p(id),
      overall: skills.reduce((sum, item) => sum + p(item.id), 0) / skills.length, practice: practice(id) ? 1 : 0
    }
  }

  /** The "What I've learned" view: plain standings, never a number. */
  view(userId: string): SkillsView {
    const { p, practice } = this.knowledge(userId)
    const seen = this.store.states(userId)
    return { skills: skills.map((item) => ({
      id: item.id, name: item.name, practice: practice(item.id),
      // Nothing is claimed about a skill Triage has never seen the person use.
      standing: (seen.get(item.id)?.opportunities ?? 0) === 0 ? 'new' : levelOf(p(item.id))
    })) }
  }

  /** A caregiver's "practice this" mark. It changes what Triage explains, not the estimate. */
  setPractice(userId: string, input: unknown): SkillsView {
    const parsed = practiceSchema.safeParse(input)
    if (!parsed.success || !isSkillId(parsed.data.id)) throw new AppProblem('invalid_input', 'That skill is not on Triage’s list.')
    this.store.setPractice(userId, parsed.data.id, parsed.data.practice, skill(parsed.data.id).prior, this.now())
    return this.view(userId)
  }

  dispose(): void { this.recent.clear(); this.pointing.clear(); this.store.close() }
}
