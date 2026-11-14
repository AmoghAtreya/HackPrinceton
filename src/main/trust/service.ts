import type { ContextSnapshot } from '../../shared/context-contracts.ts'
import {
  addChannelSchema, decideSchema, entityInputSchema, entityUpdateSchema,
  type ContactDraft, type TrustFinding, type TrustGraph, type TrustState
} from '../../shared/trust-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { idSchema, validated } from '../assistant/schemas.ts'
import { proposeContact, readAnswer, trustedContext, type ContactProposal } from './chat.ts'
import { checkClaim } from './check.ts'
import { extractClaim } from './claims.ts'
import { normalizeName } from './normalize.ts'
import type { TrustStore } from './store.ts'

/**
 * The one place the graph is changed. Each writing method names who is
 * vouching: Settings is the caregiver's entry point, a confirmed chat statement
 * and the decision buttons are the user. inspect(), which is what sees the
 * screen, only reads.
 */
export class TrustService {
  private store: TrustStore
  private changed: (state: TrustState) => void
  private warning: TrustFinding | null = null
  private latest: TrustFinding | null = null
  private dismissed?: string
  private monitoring = false
  private pending = new Map<string, ContactProposal>()

  constructor(store: TrustStore, changed: (state: TrustState) => void = () => {}) { this.store = store; this.changed = changed }

  state(): TrustState { return { warning: this.warning ? { ...this.warning, facts: [...this.warning.facts] } : null, monitoring: this.monitoring } }
  graph(): TrustGraph { return this.store.graph() }
  private publish(): void { this.changed(this.state()) }
  private setWarning(next: TrustFinding | null): void {
    const before = JSON.stringify(this.warning)
    this.warning = next
    if (JSON.stringify(next) !== before) this.publish()
  }

  // ---- Settings: the caregiver's entry point --------------------------------
  addEntity(input: unknown): TrustGraph { this.store.addEntity(validated(entityInputSchema, input), 'caregiver'); return this.graph() }
  updateEntity(input: unknown): TrustGraph {
    const { id, ...changes } = validated(entityUpdateSchema, input)
    this.store.updateEntity(id, changes, 'caregiver')
    return this.graph()
  }
  addChannel(input: unknown): TrustGraph {
    const { entityId, channel } = validated(addChannelSchema, input)
    this.store.addChannel(entityId, channel.type, channel.value, 'caregiver')
    return this.graph()
  }
  deleteEntity(input: unknown): TrustGraph { this.store.deleteEntity(validated(idSchema, input)); return this.graph() }
  deleteChannel(input: unknown): TrustGraph { this.store.deleteChannel(validated(idSchema, input)); return this.graph() }
  deleteDecision(input: unknown): TrustGraph { this.store.deleteDecision(validated(idSchema, input)); this.recheck(); return this.graph() }

  // ---- The screen: read-only -------------------------------------------------
  /** Checks what is on screen against the graph and raises or clears the warning. Never writes. */
  inspect(snapshot: ContextSnapshot | undefined): TrustFinding | null {
    const claim = snapshot ? extractClaim(snapshot) : null
    this.latest = claim ? checkClaim(this.store, claim) : null
    this.recheck()
    return this.latest
  }
  private recheck(): void {
    const finding = this.latest
    const alarming = finding && (finding.level === 'mismatch' || finding.level === 'reported_scam') ? finding : null
    if (!alarming) this.dismissed = undefined
    this.setWarning(alarming && alarming.key !== this.dismissed ? alarming : null)
  }
  /** Hides the current warning until something different is on screen. */
  dismiss(): TrustState {
    this.dismissed = this.warning?.key
    this.setWarning(null)
    return this.state()
  }
  setMonitoring(on: boolean): void {
    if (this.monitoring === on) return
    this.monitoring = on
    if (!on) { this.latest = null; this.dismissed = undefined; this.warning = null }
    this.publish()
  }

  // ---- The user's own decisions ----------------------------------------------
  /** "This is a scam" / "It's really them", for exactly the warning that is showing. */
  decide(input: unknown): TrustState {
    const { key, verdict } = validated(decideSchema, input)
    const warning = this.warning
    if (!warning || warning.key !== key || !warning.canDecide) throw new AppProblem('stale_warning', 'That warning is no longer showing. Nothing was changed.')
    this.store.decide(verdict, { claimedName: warning.claimedName, channelType: warning.channelType, channelValue: warning.channelValue, entityId: warning.entityId }, 'user')
    this.setWarning(verdict === 'genuine' ? null : {
      ...warning, level: 'reported_scam', canDecide: false,
      message: 'Thanks. Triage will remember this is a scam. Don’t reply, and don’t click anything in it.'
    })
    this.latest = this.warning
    return this.state()
  }

  // ---- Chat -------------------------------------------------------------------
  /** Turns a model suggestion into a question for the user, or null if the user's own words do not back it. Saves nothing. */
  propose(conversationId: string, draft: ContactDraft, userText: string): string | null {
    const proposal = proposeContact(draft, userText)
    if (!proposal) { this.pending.delete(conversationId); return null }
    this.pending.set(conversationId, proposal)
    return proposal.question
  }
  /**
   * If a question is waiting in this conversation, reads the user's reply to it.
   * Returns Triage's answer, or null when the message was not a yes or no (the
   * question is then dropped and the message is handled normally).
   */
  answer(conversationId: string | undefined, userText: string): string | null {
    const proposal = conversationId ? this.pending.get(conversationId) : undefined
    if (!proposal) return null
    this.pending.delete(conversationId!)
    const answer = readAnswer(userText)
    if (answer === 'no') return 'Okay, I didn’t save it.'
    if (answer !== 'yes') return null
    const existing = this.store.entities().find((entity) => entity.kind === proposal.entity.kind && normalizeName(entity.name) === normalizeName(proposal.entity.name))
    if (existing) {
      for (const channel of proposal.entity.channels) this.store.addChannel(existing.id, channel.type, channel.value, 'user')
      if (proposal.entity.relationship && !existing.relationship) {
        this.store.updateEntity(existing.id, { name: existing.name, relationship: proposal.entity.relationship, aliases: existing.aliases }, 'user')
      }
    } else this.store.addEntity(proposal.entity, 'user')
    this.recheck()
    return `Saved: ${proposal.summary}\nI’ll warn you if a message claims to be from ${proposal.entity.name} but comes from somewhere else. You can change or delete this in Settings.`
  }
  hasPending(conversationId: string | undefined): boolean { return Boolean(conversationId && this.pending.has(conversationId)) }

  /** The trusted <known_contacts> block for a chat request, or undefined when nothing is relevant. */
  context(userText: string): string | undefined { return trustedContext(this.store, userText, this.warning) }

  dispose(): void { this.pending.clear(); this.store.close() }
}
