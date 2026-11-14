import { z } from 'zod'
import type { VoiceAvailability } from '../../shared/voice-contracts.ts'

const base = { v: z.literal(1), generation: z.string().uuid(), seq: z.number().int().positive() }
const session = { ...base, sessionId: z.string().uuid() }
const authorization = z.enum(['not-determined', 'denied', 'authorized'])
export const availabilitySchema = z.object({
  microphone: authorization, speech: authorization, onDevice: z.boolean(), available: z.boolean(),
  devices: z.array(z.object({ id: z.string().min(1).max(256), label: z.string().min(1).max(256) }).strict()).max(64)
}).strict()
export const helperEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('hello'), nonce: z.string().uuid(), pid: z.number().int().positive() }).strict(),
  z.object({ ...base, type: z.literal('availability'), availability: availabilitySchema }).strict(),
  z.object({ ...base, type: z.literal('pong') }).strict(),
  z.object({ ...base, type: z.literal('shortcut'), operationId: z.string().uuid(),
    status: z.enum(['registered', 'denied', 'conflict', 'unavailable']), chord: z.string().max(64).nullable(), notice: z.string().max(512) }).strict(),
  z.object({ ...base, type: z.literal('pressed'), holdId: z.string().uuid() }).strict(),
  z.object({ ...base, type: z.literal('released'), holdId: z.string().uuid(), cancelled: z.boolean(),
    reason: z.enum(['key-up', 'modifier-up', 'startup', 'missed-release', 'watchdog', 'invalidated', 'reconfigured']) }).strict(),
  z.object({ ...base, type: z.literal('shortcut-invalidated'), notice: z.string().max(512) }).strict(),
  z.object({ ...session, type: z.literal('started') }).strict(),
  z.object({ ...session, type: z.literal('partial'), text: z.string().max(12000) }).strict(),
  z.object({ ...session, type: z.literal('level'), level: z.number().finite().min(0).max(1) }).strict(),
  z.object({ ...session, type: z.literal('final'), text: z.string().max(12000) }).strict(),
  z.object({ ...session, type: z.literal('stopped') }).strict(),
  z.object({ ...base, type: z.literal('failed'), sessionId: z.string().uuid().optional(),
    reason: z.enum(['permission', 'unavailable', 'device', 'recognition', 'audio', 'timeout', 'interrupted', 'overflow']) }).strict()
])
export type HelperEvent = z.infer<typeof helperEventSchema>
export type SpeechEvent = Exclude<HelperEvent, { type: 'hello' | 'pong' }>
export interface SpeechAdapter {
  initialize(): Promise<VoiceAvailability>
  requestPermissions(): Promise<VoiceAvailability>
  start(sessionId: string, microphoneId: string | null): void
  finish(sessionId: string): void
  cancel(sessionId: string): void
  dispose(): void | Promise<void>
}
export type AdapterFactory = (event: (event: SpeechEvent) => void, lost: () => void) => SpeechAdapter
export const MAX_FRAME = 65536
/** Bounded newline framing; a single hostile chunk cannot grow the retained buffer. */
export class HelperFrames {
  private pending = Buffer.alloc(0)
  push(chunk: Buffer): unknown[] {
    const frames: unknown[] = []
    let offset = 0
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset)
      const stop = end === -1 ? chunk.length : end
      if (this.pending.length + stop - offset > MAX_FRAME) throw new Error('frame')
      this.pending = Buffer.concat([this.pending, chunk.subarray(offset, stop)])
      if (end === -1) break
      if (frames.length >= 32) throw new Error('queue')
      frames.push(JSON.parse(this.pending.toString('utf8')))
      this.pending = Buffer.alloc(0)
      offset = end + 1
    }
    return frames
  }
}
