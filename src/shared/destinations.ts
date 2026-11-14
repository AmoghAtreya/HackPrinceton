/**
 * Places Triage can take the user. The model may only choose an id from this
 * list; it never supplies a URL. That keeps a misheard word or text on a
 * malicious page from sending an older user to a lookalike site.
 *
 * `opensIn: 'default'` opens the user's own (signed-in) browser. 'task' is
 * reserved for Triage's automated browser ("do it for me"), not built yet.
 */
export interface Destination {
  id: string
  name: string
  /** Shown to the model so it can match what the user asked for. */
  description: string
  url: string
  opensIn: 'default' | 'task'
}

export const destinations = [
  { id: 'amazon_home', name: 'Amazon', description: 'Amazon home page, shopping', url: 'https://www.amazon.com/', opensIn: 'default' },
  { id: 'amazon_orders', name: 'your Amazon orders', description: 'past Amazon orders, track a package, return an item', url: 'https://www.amazon.com/gp/css/order-history', opensIn: 'default' },
  { id: 'amazon_buy_again', name: 'Amazon Buy Again', description: 'reorder things bought before on Amazon', url: 'https://www.amazon.com/gp/buyagain', opensIn: 'default' },
  { id: 'amazon_cart', name: 'your Amazon cart', description: 'Amazon shopping cart, checkout', url: 'https://www.amazon.com/gp/cart/view.html', opensIn: 'default' },
  { id: 'amazon_help', name: 'Amazon customer service', description: 'Amazon help, contact Amazon support', url: 'https://www.amazon.com/gp/help/customer/display.html', opensIn: 'default' },
  { id: 'gmail', name: 'Gmail', description: 'Gmail email inbox', url: 'https://mail.google.com/', opensIn: 'default' },
  { id: 'google_calendar', name: 'Google Calendar', description: 'calendar, appointments', url: 'https://calendar.google.com/', opensIn: 'default' },
  { id: 'google_maps', name: 'Google Maps', description: 'maps, directions', url: 'https://www.google.com/maps', opensIn: 'default' },
  { id: 'google_news', name: 'Google News', description: 'news headlines', url: 'https://news.google.com/', opensIn: 'default' },
  { id: 'youtube', name: 'YouTube', description: 'videos', url: 'https://www.youtube.com/', opensIn: 'default' },
  { id: 'facebook', name: 'Facebook', description: 'Facebook social network, family photos', url: 'https://www.facebook.com/', opensIn: 'default' },
  { id: 'weather', name: 'the weather', description: 'weather forecast', url: 'https://weather.com/', opensIn: 'default' },
  { id: 'medicare', name: 'Medicare', description: 'Medicare.gov, Medicare account and coverage', url: 'https://www.medicare.gov/', opensIn: 'default' },
  { id: 'social_security', name: 'my Social Security', description: 'Social Security (SSA) online account, benefits', url: 'https://www.ssa.gov/myaccount/', opensIn: 'default' },
  { id: 'usps_tracking', name: 'USPS package tracking', description: 'track a US Postal Service package', url: 'https://tools.usps.com/go/TrackConfirmAction_input', opensIn: 'default' },
  { id: 'alaska_airlines', name: 'Alaska Airlines', description: 'Alaska Airlines website (to search flights, ask for a flight search instead)', url: 'https://www.alaskaair.com/', opensIn: 'default' }
] as const satisfies readonly Destination[]

/** Not a page but a Google search for the user's words; needs a `query`. */
export const WEB_SEARCH = 'web_search'

export const destinationIds: [string, ...string[]] = [WEB_SEARCH, ...destinations.map((destination) => destination.id)]

/** Every host Triage may open. Checked again right before opening. */
const allowedHosts = new Set<string>([...destinations.map((destination) => new URL(destination.url).hostname), 'www.google.com'])

export interface ResolvedDestination { id: string; name: string; url: string; opensIn: 'default' | 'task' }

/** Turns a model-chosen id (and, for web search, the query) into a vetted https URL. */
export function resolveDestination(id: string, query?: string): ResolvedDestination {
  let resolved: ResolvedDestination
  if (id === WEB_SEARCH) {
    const words = query?.trim()
    if (!words) throw new Error('A web search needs words to search for.')
    resolved = { id, name: `a web search for “${words}”`, url: 'https://www.google.com/search?q=' + encodeURIComponent(words), opensIn: 'default' }
  } else {
    const destination = (destinations as readonly Destination[]).find((entry) => entry.id === id)
    if (!destination) throw new Error('Unknown destination.')
    resolved = { id: destination.id, name: destination.name, url: destination.url, opensIn: destination.opensIn }
  }
  const url = new URL(resolved.url)
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) throw new Error('Destination is not on the allowed list.')
  return resolved
}

/** One line per destination for the routing prompt. */
export function destinationPromptList(): string {
  return destinations.map((destination) => `- ${destination.id}: ${destination.description}`).join('\n') +
    `\n- ${WEB_SEARCH}: a Google search; set "query" to the words to search for`
}
