import type { TrustDecision, TrustEntity, TrustFinding } from '../../shared/trust-contracts.ts'
import type { ScreenClaim } from './claims.ts'
import { formatPhone, hostWithin, normalizeName } from './normalize.ts'
import type { TrustReader } from './store.ts'

// Compares a claim read from the screen with the graph. Read-only: it is given
// a TrustReader, so no result of looking at the screen can change what is trusted.

const tokens = (text: string) => normalizeName(text).split(' ').filter(Boolean)
function containsRun(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true
  }
  return false
}
const names = (entity: TrustEntity) => [entity.name, ...entity.aliases].map(tokens).filter((list) => list.join('').length >= 3)

/** How strongly a claim names this entity: 0 for no match, else the length of the matched name. */
function nameScore(entity: TrustEntity, claim: ScreenClaim): number {
  let best = 0
  for (const claimed of claim.claimed) {
    const pieces = claim.kind === 'email' ? [tokens(claimed)] : claimed.split(/\s+[-–—|:·]\s+/).map(tokens)
    for (const piece of pieces) {
      if (!piece.length) continue
      for (const name of names(entity)) {
        const matches = claim.kind === 'email'
          // A display name of "Ravi" is a claim to be "Ravi Kumar"; so is "Ravi Kumar (new phone)".
          ? containsRun(piece, name) || (piece.join('').length >= 3 && containsRun(name, piece))
          // On a page only a title or heading piece that is, or leads with, the name counts:
          // "Chase" or "Amazon Sign-In", but not "Sign in with Google" on someone else's site.
          : piece.length <= name.length + 3 && name.every((token, offset) => piece[offset] === token)
        if (matches) best = Math.max(best, name.join(' ').length)
      }
    }
  }
  return best
}

const list = (values: string[]) => values.length <= 1 ? values.join('') : values.slice(0, -1).join(', ') + ' and ' + values.at(-1)
const day = (at: number) => new Date(at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
export const findingKey = (channelType: string, channelValue: string, claimedName: string) => [channelType, channelValue, normalizeName(claimedName)].join('|')

function decisionFor(decisions: TrustDecision[], claim: ScreenClaim, claimedName: string): TrustDecision | undefined {
  const same = decisions.filter((decision) => decision.channelType === claim.channelType && decision.channelValue === claim.channelValue)
  // A sender reported as a scam is a scam whatever name it uses next; "it's really them" only vouches for that name.
  return same.find((decision) => decision.verdict === 'scam') ?? same.find((decision) => decision.claimedName === normalizeName(claimedName))
}

/** Returns null when the graph has nothing to say about what is on screen. */
export function checkClaim(reader: TrustReader, claim: ScreenClaim): TrustFinding | null {
  const entities = reader.entities()
  let entity: TrustEntity | undefined
  let score = 0
  for (const candidate of entities) {
    const candidateScore = nameScore(candidate, claim)
    if (candidateScore > score) { entity = candidate; score = candidateScore }
  }
  const claimedName = entity?.name ?? claim.claimed[0] ?? ''
  const shown = (claim.claimed[0] ?? '').slice(0, 80)
  const base = {
    key: findingKey(claim.channelType, claim.channelValue, claimedName), claimedName,
    channelType: claim.channelType, channelValue: claim.channelValue, entityId: entity?.id ?? null
  }
  const arrived = claim.kind === 'email' ? `It came from: ${claim.channelValue}` : `This page is at: ${claim.channelValue}`
  const says = shown ? [(claim.kind === 'email' ? 'It says it is from: ' : 'The page calls itself: ') + shown] : []

  const decision = decisionFor(reader.decisions(), claim, claimedName)
  if (decision?.verdict === 'scam') {
    return { ...base, level: 'reported_scam', canDecide: false,
      message: claim.kind === 'email' ? 'You told Triage this sender is a scam. Don’t reply, and don’t click anything in it.' : 'You told Triage this website is a scam. Don’t type anything here.',
      facts: [...says, arrived, `You marked it as a scam on ${day(decision.createdAt)}.`, ...claim.cues] }
  }
  if (!entity) return null
  if (decision?.verdict === 'genuine') {
    return { ...base, level: 'confirmed', canDecide: false, message: `You told Triage this is really ${entity.name}.`,
      facts: [...says, arrived, `You confirmed it on ${day(decision.createdAt)}.`] }
  }

  const of = (type: string) => entity.channels.filter((channel) => channel.type === type).map((channel) => channel.value)
  const emails = of('email'); const phones = of('phone'); const sites = of('website')
  const emailDomain = claim.channelType === 'email' ? claim.channelValue.split('@')[1] : ''
  const matches = claim.channelType === 'email'
    ? emails.includes(claim.channelValue) || sites.some((site) => hostWithin(emailDomain, site))
    : sites.some((site) => hostWithin(claim.channelValue, site))
  if (matches) return { ...base, level: 'match', canDecide: false, message: `This matches what you have for ${entity.name}.`, facts: [...says, arrived] }
  // A page can only be judged against a website, and there is none on file.
  if (claim.kind === 'page' && !sites.length) return null

  const name = entity.name
  const facts = [...says, arrived]
  let message: string
  if (claim.kind === 'email') {
    message = emails.length || sites.length
      ? `This says it’s from ${name}, but ${name} uses a different email.`
      : `This says it’s from ${name}, but you have no email on your list for ${name}, so Triage can’t tell if it’s real.`
    if (emails.length) facts.push(`${name}’s email on your list: ${list(emails)}`)
    else if (sites.length) facts.push(`${name}’s real mail comes from: ${list(sites)}`)
    else facts.push(`There is no email on your list for ${name}.`)
    if (phones.length) { message += ` Call ${name} at the number you have.`; facts.push(`${name}’s phone on your list: ${list(phones.map(formatPhone))}`) }
    else if (sites.length) message += ` Go to ${sites[0]} yourself instead of using links in the message.`
    else message += ` Check with ${name} another way before you reply.`
  } else {
    message = `This page says it’s ${name}, but ${name}’s website is ${sites[0]}. This one is ${claim.channelValue}. Don’t type a password or card number here.`
    facts.push(`${name}’s website on your list: ${list(sites)}`)
  }
  return { ...base, level: 'mismatch', canDecide: true, message, facts: [...facts, ...claim.cues] }
}
