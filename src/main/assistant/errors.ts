import type { Problem, Result } from '../../shared/assistant-contracts.ts'

export class AppProblem extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function publicProblem(error: unknown): Problem {
  if (error instanceof AppProblem) return { code: error.code, message: error.message }
  return { code: 'unexpected', message: 'Something went wrong. Please try again.' }
}

export async function resultOf<T>(operation: () => T | Promise<T>): Promise<Result<T>> {
  try { return { ok: true, value: await operation() } }
  catch (error) { return { ok: false, error: publicProblem(error) } }
}
