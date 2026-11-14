import { RiskTier, type DistilledPage, type PageElement, type PageType } from '../../shared/simplifier-contracts.ts'

// All safety-relevant judgements in this file are deterministic rules over the
// page structure. Page text can try to talk an LLM into anything; it cannot
// change these results (design doc: "tiers come from rules, not the LLM").

const MONEY = /\b(pay|payment|checkout|check out|place order|buy|purchase|transfer|send money|wire|donate|subscribe|add card|billing)\b/i
const CREDENTIALS = /\b(password|passcode|pin|sign in|log ?in|security code|cvv|cvc|ssn|social security)\b/i
const COMMIT = /\b(submit|send|confirm|book|schedule|save|apply|continue|next|finish|complete|refill|order|delete|remove|cancel)\b/i
const MAIL_HOSTS = /(^|\.)(mail\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com|mail\.aol\.com|icloud\.com)$/i
const CARD_AUTOCOMPLETE = /^(cc-|transaction-)/

function host(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

function isCardField(el: PageElement): boolean {
  return Boolean(el.autocomplete && CARD_AUTOCOMPLETE.test(el.autocomplete)) || /\b(card number|credit card|debit card|expir|cvv|cvc)\b/i.test(el.label)
}
function isPasswordField(el: PageElement): boolean {
  return el.inputType === 'password' || el.autocomplete === 'current-password' || el.autocomplete === 'new-password'
}
const isField = (el: PageElement) => el.kind === 'input' || el.kind === 'textarea' || el.kind === 'select' || el.kind === 'checkbox' || el.kind === 'radio'

export function classifyPage(page: DistilledPage): PageType {
  const fields = page.elements.filter(isField)
  if (fields.some(isCardField) || page.elements.some((el) => el.kind === 'button' && MONEY.test(el.label))) return 'checkout'
  if (fields.some(isPasswordField)) return 'login'
  if (MAIL_HOSTS.test(host(page.url))) return 'email'
  if (fields.length >= 3) return 'form'
  if (page.mainText.length > 1500 || page.elements.some((el) => el.kind === 'heading' && el.region === 'main')) return 'article'
  return 'other'
}

/** Pages where the policy must not explore and tier-4 actions need extra checks. */
export function isSensitive(type: PageType): boolean {
  return type === 'checkout' || type === 'login'
}

export function riskTier(el: PageElement, page: DistilledPage): RiskTier {
  if (el.kind === 'heading' || el.kind === 'text') return RiskTier.Read
  if (isField(el)) return isPasswordField(el) || isCardField(el) || CREDENTIALS.test(el.label) ? RiskTier.MoneyOrCredentials : RiskTier.EnterData
  const label = el.label
  if (MONEY.test(label)) return RiskTier.MoneyOrCredentials
  if (el.kind === 'button' || el.inputType === 'submit') {
    // A submit next to a password or card field carries that field's risk.
    if (CREDENTIALS.test(label) || page.elements.some((other) => isField(other) && (isPasswordField(other) || isCardField(other)))) {
      return COMMIT.test(label) || CREDENTIALS.test(label) ? RiskTier.MoneyOrCredentials : RiskTier.Commit
    }
    return COMMIT.test(label) ? RiskTier.Commit : RiskTier.Navigate
  }
  return RiskTier.Navigate
}

const REGION_WEIGHT: Record<PageElement['region'], number> = { dialog: 1.0, main: 0.9, header: 0.45, other: 0.5, aside: 0.25, nav: 0.3, footer: 0.1 }
const NOISE = /\b(cookie|privacy|terms|advert|sponsored|newsletter|share|tweet|facebook|instagram|follow us|sign up for)\b/i

/**
 * Heuristic importance score in [0, 1]. Used to pre-rank elements for the LLM
 * prompt and for the rules-only fallback view. Later this is the slot for a
 * learned element-importance ranker trained on click logs.
 */
export function importance(el: PageElement): number {
  if (el.kind === 'heading' || el.kind === 'text') return 0
  let score = REGION_WEIGHT[el.region]
  score += Math.min(el.area * 20, 0.25)
  score += (1 - Math.min(el.top, 1)) * 0.15
  if (el.kind === 'button') score += 0.15
  if (COMMIT.test(el.label)) score += 0.1
  if (NOISE.test(el.label)) score -= 0.4
  if (el.label.length > 80) score -= 0.15
  return Math.max(0, Math.min(1, score))
}

export function rankElements(page: DistilledPage): PageElement[] {
  return page.elements
    .filter((el) => el.kind !== 'heading' && el.kind !== 'text')
    .map((el) => ({ el, score: importance(el) }))
    .sort((a, b) => b.score - a.score)
    .map(({ el }) => el)
}
