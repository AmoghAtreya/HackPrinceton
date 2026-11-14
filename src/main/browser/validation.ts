import type { FlightDraft, FlightSearchInput } from '../../shared/flight-contracts.ts'

export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
function calendarDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(y, m - 1, d, 12)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}
export function validateFlight(draft: FlightDraft, now = new Date()): { input?: FlightSearchInput; questions: string[] } {
  const questions: string[] = []
  const origin = draft.originAirport?.trim().toUpperCase()
  const destination = draft.destinationAirport?.trim().toUpperCase()
  if (!origin || !/^[A-Z]{3}$/.test(origin)) questions.push('What is the origin airport’s three-letter code?')
  if (!destination || !/^[A-Z]{3}$/.test(destination)) questions.push('What is the destination airport’s three-letter code?')
  if (origin && destination && origin === destination) questions.push('Choose different origin and destination airports.')
  if (!draft.tripType) questions.push('Is this one-way or round-trip?')
  const latest = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 330, 12)
  const validDate = (value: string | null) => calendarDate(value) && value >= localDate(now) && value <= localDate(latest)
  if (!validDate(draft.departureDate)) questions.push('What departure date (YYYY-MM-DD) should I use, between today and 330 days from now?')
  if (draft.tripType === 'round_trip' && (!validDate(draft.returnDate) || (draft.departureDate && draft.returnDate! < draft.departureDate)))
    questions.push('What return date (YYYY-MM-DD) should I use, on or after departure and within 330 days?')
  if (!draft.adults || draft.adults < 1 || draft.adults > 7) questions.push('How many adults are traveling (1–7)?')
  if (draft.unsupportedPassengers) questions.push('This search supports adults only. Would you like an adults-only search? Please confirm the adult count; children and infants need a manual search.')
  if (questions.length) return { questions }
  return { questions, input: { originAirport: origin!, destinationAirport: destination!, tripType: draft.tripType!,
    departureDate: draft.departureDate!, ...(draft.tripType === 'round_trip' ? { returnDate: draft.returnDate! } : {}), adults: draft.adults! } }
}
