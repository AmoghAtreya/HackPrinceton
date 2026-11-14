import type { Result } from '../../shared/assistant-contracts'

class UiProblem extends Error {}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new UiProblem(result.error.message)
  return result.value
}

export function displayError(error: unknown): string {
  return error instanceof UiProblem ? error.message : 'The desktop service could not be reached. Please restart Triage.'
}
