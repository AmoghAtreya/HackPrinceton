import { z } from 'zod'
import type { BrowserChannel } from './browser-config.ts'
import { destinationIds } from './destinations.ts'

export const flightDraftSchema = z.object({
  originAirport: z.string().max(80).nullable(), destinationAirport: z.string().max(80).nullable(),
  tripType: z.enum(['one_way', 'round_trip']).nullable(), departureDate: z.string().max(20).nullable(),
  returnDate: z.string().max(20).nullable(), adults: z.number().int().nullable(),
  unsupportedPassengers: z.boolean()
}).strict()
export type FlightDraft = z.infer<typeof flightDraftSchema>
export interface FlightSearchInput {
  originAirport: string; destinationAirport: string; tripType: 'one_way' | 'round_trip'
  departureDate: string; returnDate?: string; adults: number
}
export const routeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reply'), text: z.string().trim().min(1).max(16000) }).strict(),
  z.object({ kind: z.literal('flight_search'), flight: flightDraftSchema }).strict(),
  // Opens a curated destination in the user's own browser; the model never supplies a URL.
  z.object({ kind: z.literal('open_page'), destination: z.enum(destinationIds), query: z.string().trim().min(1).max(200).optional() }).strict()
])
export type AssistantRoute = z.infer<typeof routeSchema>
export interface ActivityEvent { seq: number; taskId: string; type: string; createdAt: number; detail: string }
export interface FlightOutcome {
  status: 'results' | 'no_results' | 'blocked' | 'failed'
  detail: string; finalUrl: string
}
export const steps = ['open_browser', 'navigate', 'consent', 'trip_type', 'origin', 'destination', 'departure', 'return', 'adults', 'submit', 'verify'] as const
export type FlightStep = typeof steps[number]
export const workerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page_navigated'), taskId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('action_proposed'), taskId: z.string().uuid(), actionId: z.string().uuid(), step: z.enum(steps) }).strict(),
  z.object({ type: z.literal('action_result'), taskId: z.string().uuid(), actionId: z.string().uuid(), step: z.enum(steps), detail: z.string().max(500) }).strict(),
  z.object({ type: z.literal('workflow_result'), taskId: z.string().uuid(), outcome: z.object({ status: z.enum(['results', 'no_results', 'blocked', 'failed']), detail: z.string().max(1000), finalUrl: z.string().max(2000) }).strict() }).strict(),
  z.object({ type: z.literal('canceled'), taskId: z.string().uuid() }).strict()
])
export type WorkerMessage = z.infer<typeof workerMessageSchema>
export type WorkerCommand =
  | { type: 'start'; taskId: string; input: FlightSearchInput; profile: string; channel: BrowserChannel }
  | { type: 'action_authorized' | 'result_saved'; taskId: string; actionId: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'close' }
export const stepLabels: Record<FlightStep, string> = {
  open_browser: 'Opening Triage’s browser', navigate: 'Opening Alaska Airlines', consent: 'Checking cookie choices',
  trip_type: 'Setting trip type', origin: 'Selecting origin airport', destination: 'Selecting destination airport',
  departure: 'Setting departure date', return: 'Setting return date', adults: 'Setting adult passengers',
  submit: 'Submitting flight search', verify: 'Checking visible search results'
}
