import type { Locator, Page } from 'playwright'
import type { FlightSearchInput, FlightOutcome, FlightStep } from '../shared/flight-contracts.ts'
export type BrowserAction = <T>(step: FlightStep, operation: () => Promise<T>, detail: string) => Promise<T>

async function property(locator: Locator, name: string, expected: string): Promise<void> {
  await locator.page().waitForFunction(({ name, expected, testId }) => {
    const element = document.querySelector(`[data-testid="${testId}"]`) as unknown as Record<string, unknown> | null
    return element && String(element[name]) === expected
  }, { name, expected, testId: await locator.getAttribute('data-testid') }, { timeout: 12000 })
}
function dateText(value: string): string { const [year, month, day] = value.split('-'); return `${month}/${day}/${year}` }
export function searchMatches(url: string, input: FlightSearchInput): boolean {
  try {
    const parsed = new URL(url)
    const q = parsed.searchParams
    return parsed.origin === 'https://www.alaskaair.com' && parsed.pathname === '/search/results' &&
      q.get('O') === input.originAirport && q.get('D') === input.destinationAirport && q.get('OD') === input.departureDate &&
      q.get('A') === String(input.adults) && q.get('RT') === String(input.tripType === 'round_trip') &&
      (input.tripType !== 'round_trip' || q.get('DD') === input.returnDate)
  } catch { return false }
}
export function publicSearchUrl(raw: string): string {
  const url = new URL(raw)
  if (url.origin !== 'https://www.alaskaair.com') return ''
  const clean = new URL(url.origin + url.pathname)
  for (const name of ['O', 'D', 'OD', 'DD', 'A', 'RT']) {
    const value = url.searchParams.get(name)
    if (value) clean.searchParams.set(name, value)
  }
  return clean.href
}
const blockedText = /verify you are human|access denied|unusual traffic|security check|pardon our interruption|temporarily blocked/i
const emptyText = /no flights (?:are |were )?(?:available|found)|we (?:couldn't|could not) find (?:any )?flights|no (?:matching |available )?flights/i
export async function failedSearch(page?: Page): Promise<FlightOutcome> {
  if (!page || page.isClosed()) return { status: 'failed', finalUrl: '', detail: page
    ? 'The task browser was closed before the search could be verified. No action was replayed.'
    : 'Chromium could not open. Run npm run browser:install, then retry. No search was submitted.' }
  const url = publicSearchUrl(page.url())
  const blocked = await page.getByText(blockedText).first().isVisible().catch(() => false)
  return { status: blocked ? 'blocked' : 'failed', finalUrl: url, detail: blocked
    ? 'Alaska displayed an access or human-verification challenge. Execution stopped without bypassing it.'
    : 'The search could not be verified: the page changed, expired, or timed out. Review the visible browser. No action was replayed.' }
}
export async function verifyResults(page: Page, input: FlightSearchInput, timeout = 45000): Promise<FlightOutcome> {
  // Visible, site-specific evidence is required in addition to the search URL.
  const container = page.getByTestId('search-results-container')
  const evidence = container.getByTestId('flight-card-0').getByRole('group', { name: 'Select a fare', exact: true })
  const outcome = await Promise.any([
    evidence.waitFor({ state: 'visible', timeout }).then(() => 'results' as const),
    page.locator('main').first().getByText(emptyText).first().waitFor({ state: 'visible', timeout }).then(() => 'no_results' as const),
    page.getByText(blockedText).first().waitFor({ state: 'visible', timeout }).then(() => 'blocked' as const)
  ])
  if (outcome === 'results') {
    const route = await container.getByTestId('flight-route').innerText()
    if (!route.includes(`(${input.originAirport})`) || !route.includes(`(${input.destinationAirport})`)) throw new Error('Visible result route does not match.')
    await container.getByTestId('departure-time').first().waitFor({ state: 'visible' })
    await evidence.getByRole('button', { name: /\$/ }).first().waitFor({ state: 'visible' })
  }
  if (outcome !== 'blocked' && !searchMatches(page.url(), input)) throw new Error('Search parameters changed before verification.')
  return { status: outcome, finalUrl: publicSearchUrl(page.url()), detail: outcome === 'results'
    ? 'Visible Alaska flight results loaded for the requested route, dates, and adult count. Review current fares in the browser.'
    : outcome === 'no_results' ? 'Alaska displayed an explicit no-flights message for this search. This is the site’s reported availability.'
    : 'Alaska displayed an access or human-verification challenge. Triage stopped; no challenge was bypassed.' }
}
export async function alaskaSearch(page: Page, input: FlightSearchInput, action: BrowserAction, signal: AbortSignal): Promise<FlightOutcome> {
  const check = () => { if (signal.aborted || page.isClosed()) throw new Error('Search stopped or browser closed.') }
  const effect = async <T>(operation: () => Promise<T>): Promise<T> => { check(); const value = await operation(); check(); return value }
  const step: BrowserAction = async (name, operation, detail) => action(name, async () => { check(); return operation() }, detail)
  await step('navigate', async () => {
    await effect(() => page.goto('https://www.alaskaair.com/search/', { waitUntil: 'domcontentloaded' }))
    await Promise.any([
      page.getByRole('button', { name: 'Search flights', exact: true }).waitFor(),
      page.getByText(blockedText).first().waitFor({ state: 'visible' })
    ])
  }, 'Alaska’s search page loaded; its form or access notice is visible.')
  if (await page.getByText(blockedText).first().isVisible()) return { status: 'blocked', detail: 'Alaska requested human verification or denied access. No bypass was attempted.', finalUrl: publicSearchUrl(page.url()) }
  await step('consent', async () => {
    const reject = page.getByRole('button', { name: /reject all|reject optional|decline optional/i }).first()
    if (await reject.isVisible()) { await effect(() => reject.click()); await reject.waitFor({ state: 'hidden' }) }
    const dialog = page.getByRole('dialog').filter({ hasText: /cookie|privacy preferences/i })
    if (await dialog.isVisible()) throw new Error('Cookie dialog requires manual review.')
  }, 'Checked for cookie choices; optional cookies were declined if offered.')
  await step('trip_type', async () => {
    const radio = page.getByRole('radio', { name: input.tripType === 'one_way' ? 'One way' : 'Round trip', exact: true })
    await effect(() => radio.click())
    if (await radio.getAttribute('aria-checked') !== 'true') throw new Error('Trip type was not selected.')
  }, `Trip type selected: ${input.tripType.replace('_', ' ')}.`)
  for (const [name, field, code] of [['origin', 'origin', input.originAirport], ['destination', 'destination', input.destinationAirport]] as const) {
    await step(name, async () => {
      const host = page.getByTestId(`city-search-input-0-${field}`)
      await effect(() => host.click())
      await effect(() => host.locator('input:visible').last().fill(code))
      const option = host.locator(`[role="option"][value="${code}"]`)
      await option.waitFor({ state: 'visible' }); await effect(() => option.click())
      await property(host, 'value', code)
    }, `Selected exact airport ${code}.`)
  }
  const picker = page.getByTestId('input-date-0')
  await step('departure', async () => {
    await effect(() => picker.click())
    const field = picker.locator('input').first()
    await effect(() => field.fill(dateText(input.departureDate))); await effect(() => field.press('Tab'))
    await property(picker, 'value', dateText(input.departureDate))
  }, `Departure entered: ${input.departureDate}.`)
  if (input.returnDate) await step('return', async () => {
    const field = picker.locator('input').nth(1)
    await effect(() => field.fill(dateText(input.returnDate!))); await effect(() => field.press('Tab'))
    await property(picker, 'valueEnd', dateText(input.returnDate!))
  }, `Return entered: ${input.returnDate}.`)
  await step('adults', async () => {
    await effect(() => page.getByRole('button', { name: /^Passengers/ }).click())
    const counter = page.getByTestId('input-adults')
    const current = Number(await counter.getByRole('spinbutton').getAttribute('aria-valuenow'))
    if (!Number.isInteger(current) || current < 0 || current > 7) throw new Error('Passenger state is invalid.')
    const name = current > input.adults ? '−' : '+'
    for (let n = 0; n < Math.abs(current - input.adults); n++) {
      await effect(() => counter.getByRole('button', { name, exact: true }).click())
    }
    await property(counter, 'value', String(input.adults))
    for (const child of ['input-children', 'input-infants']) await property(page.getByTestId(child), 'value', '0')
    await effect(() => page.getByRole('heading', { name: 'Book with us', exact: true }).click())
  }, `Verified ${input.adults} adults, zero children, and zero lap infants.`)
  await step('submit', async () => {
    const radio = page.getByRole('radio', { name: input.tripType === 'one_way' ? 'One way' : 'Round trip', exact: true })
    if (await radio.getAttribute('aria-checked') !== 'true') throw new Error('Trip type changed.')
    for (const child of ['input-children', 'input-infants']) await property(page.getByTestId(child), 'value', '0')
    if (await page.locator('#flexible-dates-checkbox').evaluate((e) => Boolean((e as unknown as { checked: boolean }).checked))) throw new Error('Flexible dates were enabled unexpectedly.')
    // Re-read every field immediately before issuing the search.
    await property(page.getByTestId('city-search-input-0-origin'), 'value', input.originAirport)
    await property(page.getByTestId('city-search-input-0-destination'), 'value', input.destinationAirport)
    await property(picker, 'value', dateText(input.departureDate))
    if (input.returnDate) await property(picker, 'valueEnd', dateText(input.returnDate))
    await property(page.getByTestId('input-adults'), 'value', String(input.adults))
    for (const id of ['input-points', 'input-nearby-origin', 'input-nearby-destination']) {
      const control = page.getByTestId(id)
      if (await control.evaluate((e) => Boolean((e as unknown as { checked: boolean }).checked))) throw new Error('Unexpected points or nearby-airports option.')
    }
    check()
    await effect(() => page.getByRole('button', { name: 'Search flights', exact: true }).click())
    await page.waitForURL((url) => searchMatches(url.href, input), { timeout: 30000, waitUntil: 'domcontentloaded' })
  }, 'Search submitted; requested route, dates, trip type, and adult count match Alaska’s search state.')
  return step('verify', () => verifyResults(page, input), 'Visible search outcome verified against the requested search.')
}
