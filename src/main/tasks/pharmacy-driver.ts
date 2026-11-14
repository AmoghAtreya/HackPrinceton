import type { Page } from 'playwright'
import { RiskTier } from '../../shared/simplifier-contracts.ts'
import { distillPage } from '../simplifier/distill.ts'
import { riskTier } from '../simplifier/classify.ts'

export interface RefillForm { name: string; dateOfBirth: string; rx: string; store: string; pickupTime: string }

/** Everything the refill graph needs from a browser. A fake implements it in tests. */
export interface RefillDriver {
  readonly site: string
  open(): Promise<void>
  /** Fills the form (tier 2: enter data) and returns what was entered, for read-back. */
  fill(form: RefillForm): Promise<Array<{ label: string; value: string }>>
  /** Risk tier of the submit control, from rules over the page, never from a model. */
  submitTier(): Promise<RiskTier>
  submit(): Promise<{ confirmation: string }>
}

export const DEMO_PHARMACY_ORIGIN = 'https://pharmacy.triage-demo.invalid'

/** Pick the option whose text best matches a remembered preference ("CVS on Main St" → "… Main Street"). */
export function bestOption(options: string[], wanted: string): string | undefined {
  const words = wanted.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !['the', 'and', 'pharmacy', 'store', 'carewell'].includes(word))
  let best: string | undefined
  let bestScore = 0
  for (const option of options) {
    const text = option.toLowerCase()
    const score = words.filter((word) => text.includes(word) || (word === 'st' && text.includes('street'))).length
    if (score > bestScore) { bestScore = score; best = option }
  }
  return best
}

/**
 * Drives the mock CareWell refill page in Triage's Chrome window. The page is
 * served from bundled HTML on a reserved `.invalid` domain, so the demo can
 * never reach a real pharmacy. Supporting a real site means a new driver plus
 * a recorded recipe, not changes to the graph.
 */
export class DemoPharmacyDriver implements RefillDriver {
  readonly site = 'pharmacy.triage-demo.invalid'
  private readonly page: () => Promise<Page>
  private readonly html: string
  private current?: Page

  constructor(page: () => Promise<Page>, html: string) { this.page = page; this.html = html }

  private async live(): Promise<Page> {
    if (!this.current || this.current.isClosed()) throw new Error('The pharmacy page was closed.')
    return this.current
  }

  async open(): Promise<void> {
    const page = await this.page()
    await page.route(DEMO_PHARMACY_ORIGIN + '/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: this.html }))
    await page.goto(DEMO_PHARMACY_ORIGIN + '/refill', { waitUntil: 'load' })
    await page.bringToFront().catch(() => {})
    this.current = page
  }

  async fill(form: RefillForm): Promise<Array<{ label: string; value: string }>> {
    const page = await this.live()
    await page.getByLabel('Full name').fill(form.name)
    await page.getByLabel('Date of birth').fill(form.dateOfBirth)
    await page.getByLabel('Prescription number').fill(form.rx)
    const stores = await page.getByLabel('Pickup store').locator('option').allTextContents()
    const store = bestOption(stores, form.store) ?? stores.find((option) => option && !/choose/i.test(option))!
    await page.getByLabel('Pickup store').selectOption({ label: store })
    const times = await page.getByLabel('Pickup time').locator('option').allTextContents()
    const time = times.find((option) => option.toLowerCase().startsWith(form.pickupTime.toLowerCase())) ?? times[1]
    await page.getByLabel('Pickup time').selectOption({ label: time })
    return [
      { label: 'Name', value: form.name }, { label: 'Date of birth', value: form.dateOfBirth },
      { label: 'Prescription number', value: form.rx }, { label: 'Pickup store', value: store }, { label: 'Pickup time', value: time }
    ]
  }

  async submitTier(): Promise<RiskTier> {
    const page = await this.live()
    const distilled = await distillPage(page)
    const button = distilled.elements.find((el) => el.kind === 'button' && /request refill|submit/i.test(el.label))
    // Unknown submit control: treat as the highest tier so the graph refuses.
    return button ? riskTier(button, distilled) : RiskTier.MoneyOrCredentials
  }

  async submit(): Promise<{ confirmation: string }> {
    const page = await this.live()
    await page.getByRole('button', { name: 'Request refill' }).click()
    const confirmation = await page.locator('#confirmation').innerText({ timeout: 8000 })
    return { confirmation: confirmation.trim() }
  }
}
