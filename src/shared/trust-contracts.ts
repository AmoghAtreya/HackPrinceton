import { z } from 'zod'

// ---------------------------------------------------------------------------
// The trust graph: the people and organizations the user really deals with,
// and how each one really reaches them. It lives only on this Mac. It holds
// contact facts and the user's own decisions; never message text, full URLs
// or secrets.
// ---------------------------------------------------------------------------

export const entityKinds = ['person', 'organization'] as const
export type EntityKind = typeof entityKinds[number]
export const channelTypes = ['email', 'phone', 'website'] as const
export type ChannelType = typeof channelTypes[number]
/**
 * Who vouched for a fact. There is deliberately no "screen" value: nothing
 * Triage reads off the screen can be written to the graph.
 */
export const provenances = ['user', 'caregiver', 'seed'] as const
export type Provenance = typeof provenances[number]

export interface TrustChannel { id: string; type: ChannelType; value: string; source: Provenance; createdAt: number }
export interface TrustEntity {
  id: string; kind: EntityKind; name: string; relationship: string
  /** Other names this entity goes by, e.g. "Ravi" for "Ravi Kumar". */
  aliases: string[]
  channels: TrustChannel[]
  source: Provenance; createdAt: number; updatedAt: number
}
export type Verdict = 'scam' | 'genuine'
/** The user's own answer about one sender. Keyed by who it claimed to be and how it arrived, never by what it said. */
export interface TrustDecision {
  id: string; verdict: Verdict; claimedName: string; channelType: ChannelType; channelValue: string
  entityId: string | null; createdAt: number
}
export interface TrustGraph { entities: TrustEntity[]; decisions: TrustDecision[] }

export type FindingLevel = 'mismatch' | 'reported_scam' | 'confirmed' | 'match'
/** The result of checking what is on screen against the graph. Lives in memory only. */
export interface TrustFinding {
  /** Stable for one (claimed name, channel) pair, so answering it applies to exactly what was shown. */
  key: string
  level: FindingLevel
  /** One plain sentence or two, safe to read aloud. */
  message: string
  /** The facts behind the message, each a short plain line. */
  facts: string[]
  claimedName: string
  channelType: ChannelType
  channelValue: string
  entityId: string | null
  /** False once the user has already answered for this sender. */
  canDecide: boolean
}
export interface TrustState {
  /** The current warning, if what is on screen does not match the graph. */
  warning: TrustFinding | null
  monitoring: boolean
}

const text = (max: number) => z.string().trim().min(1).max(max)
export const channelInputSchema = z.object({ type: z.enum(channelTypes), value: text(320) }).strict()
export type ChannelInput = z.infer<typeof channelInputSchema>
export const entityInputSchema = z.object({
  kind: z.enum(entityKinds), name: text(80), relationship: z.string().trim().max(80).default(''),
  aliases: z.array(text(80)).max(8).default([]), channels: z.array(channelInputSchema).max(12).default([])
}).strict()
export type EntityInput = z.infer<typeof entityInputSchema>
export const entityUpdateSchema = z.object({
  id: z.uuid(), name: text(80), relationship: z.string().trim().max(80), aliases: z.array(text(80)).max(8)
}).strict()
export const addChannelSchema = z.object({ entityId: z.uuid(), channel: channelInputSchema }).strict()
export const decideSchema = z.object({ key: z.string().min(1).max(600), verdict: z.enum(['scam', 'genuine']) }).strict()

/** What the model returns in a remember_contact route. Only a suggestion: see main/trust/chat.ts. */
export const contactDraftSchema = z.object({
  kind: z.enum(entityKinds), name: z.string().trim().min(1).max(80),
  relationship: z.string().trim().max(80).nullable(), email: z.string().trim().max(320).nullable(),
  phone: z.string().trim().max(40).nullable(), website: z.string().trim().max(253).nullable()
}).strict()
export type ContactDraft = z.infer<typeof contactDraftSchema>

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
export interface TrustBridge {
  getTrustGraph(): Promise<Result<TrustGraph>>
  addTrustEntity(input: EntityInput): Promise<Result<TrustGraph>>
  updateTrustEntity(input: z.infer<typeof entityUpdateSchema>): Promise<Result<TrustGraph>>
  deleteTrustEntity(id: string): Promise<Result<TrustGraph>>
  addTrustChannel(input: z.infer<typeof addChannelSchema>): Promise<Result<TrustGraph>>
  deleteTrustChannel(id: string): Promise<Result<TrustGraph>>
  deleteTrustDecision(id: string): Promise<Result<TrustGraph>>
  getTrustState(): Promise<Result<TrustState>>
  decideTrust(input: z.infer<typeof decideSchema>): Promise<Result<TrustState>>
  dismissTrustWarning(): Promise<Result<TrustState>>
  onTrustState(listener: (state: TrustState) => void): () => void
}
export const trustChannels = {
  graph: 'trust:graph', addEntity: 'trust:add-entity', updateEntity: 'trust:update-entity', deleteEntity: 'trust:delete-entity',
  addChannel: 'trust:add-channel', deleteChannel: 'trust:delete-channel', deleteDecision: 'trust:delete-decision',
  getState: 'trust:get-state', decide: 'trust:decide', dismiss: 'trust:dismiss', state: 'trust:state'
} as const
