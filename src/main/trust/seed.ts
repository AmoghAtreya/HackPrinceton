import { destinations } from '../../shared/destinations.ts'
import type { EntityInput } from '../../shared/trust-contracts.ts'
import { normalizeHost } from './normalize.ts'
import type { TrustStore } from './store.ts'

// The organizations Triage already knows how to reach (shared/destinations.ts)
// are the ones it can vouch for out of the box. Several destinations belong to
// one organization ("your Amazon orders", "Amazon Buy Again"), so they are
// grouped by site and named once.

const NAMES: Record<string, { name: string; aliases?: string[] }> = {
  'amazon.com': { name: 'Amazon' },
  'google.com': { name: 'Google', aliases: ['Gmail', 'Google Calendar', 'Google Maps', 'Google News'] },
  'youtube.com': { name: 'YouTube' },
  'facebook.com': { name: 'Facebook' },
  'weather.com': { name: 'The Weather Channel' },
  'medicare.gov': { name: 'Medicare' },
  'ssa.gov': { name: 'Social Security', aliases: ['Social Security Administration', 'SSA'] },
  'usps.com': { name: 'USPS', aliases: ['US Postal Service', 'United States Postal Service'] },
  'alaskaair.com': { name: 'Alaska Airlines' }
}
/** "mail.google.com" and "tools.usps.com" belong to google.com and usps.com. Enough for a fixed, known list. */
const site = (host: string) => host.split('.').slice(-2).join('.')

export function seedOrganizations(): Array<{ key: string; entity: EntityInput }> {
  const sites = new Set<string>()
  for (const destination of destinations) {
    const host = normalizeHost(destination.url)
    if (host) sites.add(site(host))
  }
  return [...sites].map((key) => ({
    key, entity: {
      kind: 'organization' as const, name: NAMES[key]?.name ?? key, relationship: '', aliases: NAMES[key]?.aliases ?? [],
      channels: [{ type: 'website' as const, value: key }]
    }
  }))
}

/** Adds any built-in organization that is neither present nor deliberately deleted. Safe to run on every launch. */
export function seedStore(store: TrustStore): number {
  let added = 0
  for (const { key, entity } of seedOrganizations()) {
    if (store.hasSeed(key)) continue
    store.addEntity(entity, 'seed', key)
    added++
  }
  return added
}
