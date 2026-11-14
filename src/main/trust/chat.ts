import type { ContactDraft, EntityInput, TrustEntity, TrustFinding } from '../../shared/trust-contracts.ts'
import { formatPhone, maskChannel, normalizeEmail, normalizeHost, normalizeName, normalizePhone } from './normalize.ts'
import type { TrustReader } from './store.ts'

// ---------------------------------------------------------------------------
// Chat -> graph. The model may suggest that the user stated a contact fact, but
// a suggestion is only a suggestion: a model's output can be steered by text on
// the screen. Two checks that involve no model stand between it and the graph:
//   1. every value must appear, literally, in the message the user typed, and
//   2. the user must then answer "yes" to a question that spells the fact out.
// ---------------------------------------------------------------------------

export interface ContactProposal { entity: EntityInput; question: string; summary: string }

function describe(entity: EntityInput): string {
  const details = entity.channels.map((channel) => channel.type === 'email' ? `email ${channel.value}`
    : channel.type === 'phone' ? `phone ${formatPhone(channel.value)}` : `website ${channel.value}`)
  return entity.name + (entity.relationship ? ` (${entity.relationship})` : '') + (details.length ? ': ' + details.join(', ') : '')
}

/**
 * Keeps only what the user's own words contain. Returns null when the name is
 * not in the message, or nothing checkable is left. `userText` must be the
 * typed or spoken message alone, never the screen context sent alongside it.
 */
export function proposeContact(draft: ContactDraft, userText: string): ContactProposal | null {
  const spoken = ' ' + normalizeName(userText) + ' '
  const lower = userText.toLowerCase()
  const digits = userText.replace(/\D/g, '')
  const said = (phrase: string) => Boolean(normalizeName(phrase)) && spoken.includes(' ' + normalizeName(phrase) + ' ')
  if (!said(draft.name)) return null
  const channels: EntityInput['channels'] = []
  const email = draft.email ? normalizeEmail(draft.email) : null
  if (email && lower.includes(email)) channels.push({ type: 'email', value: email })
  const phone = draft.phone ? normalizePhone(draft.phone) : null
  if (phone && digits.includes(phone)) channels.push({ type: 'phone', value: phone })
  const website = draft.website ? normalizeHost(draft.website) : null
  if (website && lower.includes(website)) channels.push({ type: 'website', value: website })
  const relationship = draft.relationship && said(draft.relationship) ? draft.relationship : ''
  if (!channels.length && !relationship) return null
  const entity: EntityInput = { kind: draft.kind, name: draft.name, relationship, aliases: [], channels }
  const summary = describe(entity)
  return { entity, summary, question: `Should I remember this?\n${summary}\n\nReply “yes” to save it, or “no” to skip. You can see and change your list in Settings.` }
}

const YES = /^(yes|yes please|yep|yeah|yup|ok|okay|sure|save it|please do|correct|that'?s right)[.! ]*$/i
const NO = /^(no|no thanks|nope|don'?t|do not|skip|cancel|never mind)[.! ]*$/i
/** A deterministic reading of the user's answer to the question above; anything else is not an answer. */
export function readAnswer(text: string): 'yes' | 'no' | null {
  const answer = text.trim()
  return YES.test(answer) ? 'yes' : NO.test(answer) ? 'no' : null
}

// ---------------------------------------------------------------------------
// Graph -> chat. A few relevant facts go in the system prompt, apart from the
// untrusted screen context in the user turn. The graph itself stays on this
// Mac: the model gets names, relationships and masked hints, never a full
// address or number.
// ---------------------------------------------------------------------------

export const KNOWN_CONTACTS_TAG = 'known_contacts'
const MAX_CONTACTS = 5

function mentioned(entity: TrustEntity, text: string): boolean {
  const spoken = ' ' + normalizeName(text) + ' '
  return [entity.name, ...entity.aliases].some((name) => normalizeName(name).length >= 3 && spoken.includes(' ' + normalizeName(name) + ' '))
}

export function trustedContext(reader: TrustReader, userText: string, finding: TrustFinding | null): string | undefined {
  const flagged = finding && finding.level !== 'match' && finding.level !== 'confirmed' ? finding : null
  const entities = reader.entities()
  const relevant = entities.filter((entity) => entity.id === flagged?.entityId || mentioned(entity, userText)).slice(0, MAX_CONTACTS)
  if (!relevant.length && !flagged) return undefined
  const safe = (text: string) => text.replace(/[<>\r\n]/g, ' ').trim()
  const lines = relevant.map((entity) => {
    const hints = entity.channels.map((channel) => channel.type === 'website' ? 'website ' + channel.value : maskChannel(channel.type, channel.value))
    return `- ${safe(entity.name)} (${entity.kind}${entity.relationship ? ', ' + safe(entity.relationship) : ''}): ${hints.length ? hints.join('; ') : 'no contact details on file'}`
  })
  return [`<${KNOWN_CONTACTS_TAG}>`,
    'People and organizations the user or their caregiver has confirmed. Trusted. Contact details are partly hidden on purpose: never guess or complete them, and tell the user to look in Settings for the full details.',
    ...lines,
    ...(flagged ? ['Result of Triage’s own check of what is on screen right now: ' + safe(flagged.message)] : []),
    `</${KNOWN_CONTACTS_TAG}>`].join('\n')
}
