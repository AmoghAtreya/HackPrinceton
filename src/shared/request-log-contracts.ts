import type { Result } from './assistant-contracts'

/**
 * Opt-in request log ("Help improve Triage"). Phase 1 keeps an outbox on this
 * Mac; a later phase uploads it (API Gateway → Lambda with Amazon Comprehend
 * PII redaction → DynamoDB) to suggest FAQs and new destinations.
 */

export type RequestRoute = 'reply' | 'flight_search' | 'open_page' | 'explain' | 'highlight' | 'simplify' | 'safety'
  | 'simplify_page' | 'needs_screenshot' | 'how_to' | 'remember_contact'
export type RequestOutcome = 'completed' | 'failed' | 'stopped' | 'interrupted'

export interface RequestEvent {
  eventId: string
  /** Random id for this install, not tied to any account; rotated by "Delete my data". */
  installId: string
  at: number
  source: 'chat' | 'voice' | 'shake'
  /** The request with known secrets removed. Full PII redaction happens before upload. */
  text: string
  route?: RequestRoute
  /** For open_page: the destination id chosen. */
  destination?: string
  outcome: RequestOutcome
  /** The reply (completed requests) with known secrets removed, shortened. */
  reply?: string
  /** Why it failed, for failed or interrupted requests. */
  error?: string
  latencyMs: number
  appVersion: string
}

export interface RequestLogSettings {
  /** Off until the user opts in. */
  shareRequests: boolean
  /** Requests waiting in the local outbox. */
  pending: number
  warning?: string
}

export interface RequestLogBridge {
  getRequestLogSettings(): Promise<Result<RequestLogSettings>>
  saveRequestLogSettings(input: { shareRequests: boolean }): Promise<Result<RequestLogSettings>>
  /** Deletes everything logged and starts a new anonymous install id. */
  clearRequestLog(): Promise<Result<RequestLogSettings>>
}

export const requestLogChannels = {
  getSettings: 'request-log:get-settings',
  saveSettings: 'request-log:save-settings',
  clear: 'request-log:clear'
} as const
