import type { DistilledPage, PageElement } from '../../shared/simplifier-contracts.ts'

// The rebuilt page keeps the original page's links, so the person can still
// sign in, find their orders or returns, and move around the site. Grouping is
// deterministic rules over the distilled page; the LLM never adds or changes a
// link, and only http(s) addresses that were really on the page are kept.

export interface PageLink {
  elementId: string
  label: string
  href: string
  /** Set when the link leaves the site, so the person can see where it goes. */
  externalHost?: string
}
export interface LinkGroup {
  id: 'account' | 'menu' | 'content' | 'footer'
  title: string
  links: PageLink[]
}

/** Links people come back to a site for: their account, orders, returns, cart and help. */
export const ACCOUNT_LINK = /\b(sign ?in|sign ?out|log ?in|log ?out|sign ?up|register|account|profile|orders?|returns?|cart|basket|wish ?list|track|deliver(y|ies)|subscriptions?|prime|help|customer service|contact us)\b/i
const NOISE = /^(skip to|back to top|close|menu|more|see more|show more|learn more|read more|click here|here|details)$/i

const LIMITS: Record<LinkGroup['id'], number> = { account: 12, menu: 24, content: 40, footer: 20 }
const TITLES: Record<LinkGroup['id'], string> = {
  account: 'Your account, orders and help',
  menu: 'Main menu',
  content: 'Links on this page',
  footer: 'More links at the bottom of the page'
}
const MAX_LABEL = 80

/** http(s) only, without the #fragment. */
function webHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    url.hash = ''
    return url.href
  } catch { return undefined }
}

/** "www.amazon.com" and "smile.amazon.com" count as the same site; a different domain is external. */
function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.')
  // Keep three labels for two-part country suffixes such as amazon.co.uk.
  const keep = parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3 ? 3 : 2
  return parts.slice(-keep).join('.')
}

function groupFor(el: PageElement): LinkGroup['id'] | null {
  if (el.region === 'promo' || el.region === 'dialog') return null
  // Short labels only, so a product or article title that mentions "returns" stays where it was.
  if (ACCOUNT_LINK.test(el.label) && el.label.length <= 40) return 'account'
  if (el.region === 'header' || el.region === 'nav') return 'menu'
  if (el.region === 'footer') return 'footer'
  return 'content'
}

/**
 * The page's real links, grouped for the rebuilt view. Links already shown as
 * main action buttons, links back to this same page, duplicates and empty or
 * filler labels ("Read more") are left out. Groups with no links are omitted.
 */
export function pageLinks(page: DistilledPage, shownIds: Iterable<string> = []): LinkGroup[] {
  const shown = new Set(shownIds)
  const self = webHref(page.url)
  let pageSite = ''
  try { pageSite = siteOf(new URL(page.url).hostname) } catch { /* Every link then shows its host. */ }
  const seen = new Set<string>()
  for (const id of shown) {
    const href = webHref(page.elements.find((el) => el.id === id)?.href)
    if (href) seen.add(href)
  }
  const groups = new Map<LinkGroup['id'], PageLink[]>()
  for (const el of page.elements) {
    if (el.kind !== 'link' || shown.has(el.id)) continue
    const href = webHref(el.href)
    const label = el.label.replace(/\s+/g, ' ').trim()
    if (!href || href === self || seen.has(href) || !label || NOISE.test(label)) continue
    const group = groupFor(el)
    if (!group) continue
    const list = groups.get(group) ?? []
    if (list.length >= LIMITS[group]) continue
    seen.add(href)
    const host = new URL(href).hostname
    list.push({
      elementId: el.id, href,
      label: label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1).trimEnd() + '…' : label,
      ...(siteOf(host) !== pageSite ? { externalHost: host } : {})
    })
    groups.set(group, list)
  }
  return (['account', 'menu', 'content', 'footer'] as const)
    .filter((id) => groups.get(id)?.length)
    .map((id) => ({ id, title: TITLES[id], links: groups.get(id)! }))
}
