import { z } from 'zod'
import { AppProblem } from './errors.ts'

export const idSchema = z.string().uuid()
export const rateSchema = z.object({ decisionId: z.string().uuid(), helpful: z.boolean() }).strict()
export const sendSchema = z.object({
  conversationId: idSchema.optional(),
  captureId: idSchema.optional(),
  mode: z.enum(['explain', 'highlight']).optional(),
  /** How the user entered the text; 'voice' marks a spoken (transcribed) message. */
  source: z.enum(['chat', 'voice']).optional(),
  text: z.string().trim().min(1).max(4000)
}).strict().refine((request) => request.mode !== 'highlight' || Boolean(request.captureId))
export const connectSchema = z.object({
  key: z.string().trim().min(20).max(512).regex(/^[\x21-\x7e]+$/),
  remember: z.boolean()
}).strict()
export const modelSchema = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9._:-]+$/)
export const listSchema = z.object({
  before: z.object({ at: z.number().int().nonnegative(), id: idSchema }).strict().optional()
}).strict()
export const detailSchema = z.object({
  id: idSchema, before: z.number().int().positive().optional(), beforeEvent: z.number().int().positive().optional()
}).strict()

export function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new AppProblem('invalid_input', 'Check the request fields and try again.')
  return result.data
}
