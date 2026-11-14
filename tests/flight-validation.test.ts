import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateFlight } from '../src/main/browser/validation.ts'
import { routeSchema, type FlightDraft } from '../src/shared/flight-contracts.ts'
import { searchMatches } from '../src/worker/alaska.ts'
const now = new Date(2026, 10, 10, 23, 30)
const draft: FlightDraft = { originAirport: 'SEA', destinationAirport: 'SFO', tripType: 'round_trip', departureDate: '2026-12-10', returnDate: '2026-12-15', adults: 2, unsupportedPassengers: false }
test('flight validation accepts explicit airports and local calendar dates', () => {
  const { input, questions } = validateFlight(draft, now)
  assert.deepEqual(questions, []); assert.equal(input?.departureDate, '2026-12-10')
  assert.equal(validateFlight({ ...draft, tripType: 'one_way', returnDate: null }, now).input?.returnDate, undefined)
})
test('flight validation clarifies ambiguous airports and missing fields', () => {
  assert.equal(validateFlight({ ...draft, originAirport: 'New Jersey', adults: null, tripType: null, departureDate: null }, now).questions.length, 4)
  for (const patch of [{ destinationAirport: 'SEA' }, { adults: 8 }, { adults: 0 }, { departureDate: '2026-02-30' }, { departureDate: '2026-11-09' }, { returnDate: '2026-12-09' }, { returnDate: '2028-01-01' }, { unsupportedPassengers: true }]) {
    assert.equal(validateFlight({ ...draft, ...patch }, now).input, undefined, JSON.stringify(patch))
  }
})
test('routing rejects arbitrary actions and malformed responses', () => {
  assert.equal(routeSchema.safeParse({ kind: 'purchase', text: 'buy' }).success, false)
  assert.equal(routeSchema.safeParse({ kind: 'flight_search', flight: { ...draft, execute: 'evil' } }).success, false)
})
test('search verification requires exact host route and all requested parameters', () => {
  const input = validateFlight(draft, now).input!
  const url = 'https://www.alaskaair.com/search/results?O=SEA&D=SFO&OD=2026-12-10&DD=2026-12-15&A=2&RT=true'
  assert.equal(searchMatches(url, input), true)
  for (const bad of [url.replace('www.alaskaair.com', 'evil.example'), url.replace('A=2', 'A=1'), url.replace('DD=2026-12-15', 'DD=2026-12-16'), url.replace('D=SFO', 'D=LAX'), url.replace('RT=true', 'RT=false')]) assert.equal(searchMatches(bad, input), false)
})
