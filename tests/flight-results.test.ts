import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { verifyResults } from '../src/worker/alaska.ts'
const input = { originAirport: 'SEA', destinationAirport: 'SFO', tripType: 'one_way' as const, departureDate: '2026-12-10', adults: 1 }
const url = 'https://www.alaskaair.com/search/results?O=SEA&D=SFO&OD=2026-12-10&A=1&RT=false'
async function fixture(html: string, run: (page: import('playwright').Page) => Promise<void>) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(500)
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto(url); await run(page)
  } finally { await browser.close() }
}
test('visible route flight time and fare evidence establishes results', async () => {
  await fixture(`<main><div data-testid="search-results-container"><b data-testid="flight-route">Seattle (SEA) to San Francisco (SFO)</b>
    <div data-testid="flight-card-0"><span data-testid="departure-time">7:20 am</span><div role="group" aria-label="Select a fare"><button>Main $99 one way</button></div></div></div></main>`, async (page) => {
    assert.equal((await verifyResults(page, input, 500)).status, 'results')
  })
})
test('explicit empty results and human verification are distinct outcomes', async () => {
  await fixture('<main><p>No flights were found for your search.</p></main>', async (page) => {
    assert.equal((await verifyResults(page, input, 500)).status, 'no_results')
  })
  await fixture('<main><p>Verify you are human</p></main>', async (page) => {
    assert.equal((await verifyResults(page, input, 500)).status, 'blocked')
  })
})
test('a matching URL with unfinished content is never treated as empty results', async () => {
  await fixture('<main>Loading flights…</main>', async (page) => { await assert.rejects(verifyResults(page, input, 100)) })
})
test('visible result cards for a different route fail verification', async () => {
  await fixture(`<main><div data-testid="search-results-container"><b data-testid="flight-route">Seattle (SEA) to Los Angeles (LAX)</b>
    <div data-testid="flight-card-0"><div role="group" aria-label="Select a fare"><button>Main $99</button></div></div></div></main>`, async (page) => {
    await assert.rejects(verifyResults(page, input, 500), /does not match/)
  })
})
