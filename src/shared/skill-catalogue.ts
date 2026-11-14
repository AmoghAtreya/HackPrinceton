// ---------------------------------------------------------------------------
// The fixed catalogue of things a person can know how to do on a computer, and
// which skills each one builds on. This list is the only source of skill ids:
// the model may pick from it but can never add to it, and anything it names
// that is not here is dropped.
//
// IDs are stored in the learning record, so never rename or reuse one; add new
// skills instead.
// ---------------------------------------------------------------------------

export interface Skill {
  id: string
  /** Plain words, shown to the user and given to the model. */
  name: string
  /** Skills that must come first. Direct prerequisites only. */
  requires: readonly string[]
  /** How likely someone is to know this before Triage has seen anything. Basics start higher. */
  prior: number
}

export const skills = [
  { id: 'click', name: 'click with the mouse or trackpad', requires: [], prior: 0.7 },
  { id: 'scroll', name: 'scroll up and down a page', requires: ['click'], prior: 0.6 },
  { id: 'type_text', name: 'type into a box', requires: ['click'], prior: 0.6 },
  { id: 'find_button', name: 'find a button or link on a page', requires: ['scroll'], prior: 0.4 },
  { id: 'close_popup', name: 'close a pop-up', requires: ['find_button'], prior: 0.3 },
  { id: 'open_website', name: 'open a website', requires: ['type_text'], prior: 0.4 },
  { id: 'web_search', name: 'search the web', requires: ['open_website'], prior: 0.4 },
  { id: 'read_address', name: 'read the website address at the top of the window', requires: ['open_website'], prior: 0.25 },
  { id: 'spot_fake_link', name: 'spot a fake link or website', requires: ['read_address'], prior: 0.15 },
  { id: 'fill_form', name: 'fill in a form', requires: ['type_text', 'find_button'], prior: 0.3 },
  { id: 'sign_in', name: 'sign in with a username and password', requires: ['fill_form'], prior: 0.3 },
  { id: 'sign_in_medicare', name: 'log in to Medicare', requires: ['sign_in', 'open_website'], prior: 0.15 },
  { id: 'pay_online', name: 'pay for something online', requires: ['fill_form', 'spot_fake_link'], prior: 0.15 },
  { id: 'read_email', name: 'open and read an email', requires: ['find_button'], prior: 0.4 },
  { id: 'send_email', name: 'write and send an email', requires: ['read_email', 'type_text'], prior: 0.3 },
  { id: 'pick_file', name: 'choose a file or photo from the computer', requires: ['click'], prior: 0.25 },
  { id: 'attach_photo', name: 'attach a photo to an email', requires: ['send_email', 'pick_file'], prior: 0.15 },
  { id: 'spot_scam_message', name: 'spot a scam message', requires: ['read_email'], prior: 0.15 }
] as const satisfies readonly Skill[]

export type SkillId = typeof skills[number]['id']
export const skillIds = skills.map((skill) => skill.id) as SkillId[]
const byId = new Map<string, Skill>(skills.map((skill) => [skill.id, skill]))

export function isSkillId(value: unknown): value is SkillId { return typeof value === 'string' && byId.has(value) }
export function skill(id: SkillId): Skill { return byId.get(id)! }

/** Keeps only real catalogue ids, in the order given, without duplicates. */
export function catalogueOnly(values: readonly unknown[], limit = 3): SkillId[] {
  const kept: SkillId[] = []
  for (const value of values) if (isSkillId(value) && !kept.includes(value)) kept.push(value)
  return kept.slice(0, limit)
}

/** Every skill `id` builds on, directly or not, ordered so that each comes after its own prerequisites. */
export function prerequisitesOf(id: SkillId): SkillId[] {
  const ordered: SkillId[] = []
  const visit = (current: SkillId, trail: SkillId[]): void => {
    if (trail.includes(current)) throw new Error('The skill catalogue has a prerequisite loop at ' + current)
    for (const needed of skill(current).requires as readonly SkillId[]) {
      visit(needed, [...trail, current])
      if (!ordered.includes(needed)) ordered.push(needed)
    }
  }
  visit(id, [])
  return ordered
}

/** One line per skill for the routing prompt. */
export function skillPromptList(): string {
  return skills.map((item) => `- ${item.id}: ${item.name}`).join('\n')
}
