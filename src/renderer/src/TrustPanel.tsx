import { useEffect, useState, type FormEvent } from 'react'
import type { DesktopBridge } from '../../shared/contracts'
import type { ChannelType, EntityKind, TrustEntity, TrustGraph } from '../../shared/trust-contracts'
import { displayError, unwrap } from './assistant-ui'

const CHANNEL_LABEL: Record<ChannelType, string> = { email: 'Email', phone: 'Phone', website: 'Website' }
const SOURCE_LABEL = { user: 'you told Triage', caregiver: 'added in Settings', seed: 'built in' } as const
const phone = (digits: string) => digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : digits

/** Settings: see, add, edit and delete everything in the trust graph. This is where a caregiver enters it. */
export function TrustPanel({ bridge }: { bridge: DesktopBridge }) {
  const [graph, setGraph] = useState<TrustGraph | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState({ kind: 'person' as EntityKind, name: '', relationship: '', email: '', phone: '', website: '' })
  const [adding, setAdding] = useState<{ id: string; type: ChannelType; value: string } | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string; relationship: string; aliases: string } | null>(null)
  useEffect(() => {
    let mounted = true
    bridge.getTrustGraph().then((result) => { if (mounted) setGraph(unwrap(result)) }).catch((problem) => { if (mounted) setError(displayError(problem)) })
    return () => { mounted = false }
  }, [bridge])

  async function run(action: () => Promise<{ ok: true; value: TrustGraph } | { ok: false; error: { code: string; message: string } }>, done?: () => void) {
    setBusy(true); setError('')
    try { setGraph(unwrap(await action())); done?.() }
    catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }
  function add(event: FormEvent) {
    event.preventDefault()
    const channels = (['email', 'phone', 'website'] as const).filter((type) => draft[type].trim()).map((type) => ({ type, value: draft[type].trim() }))
    void run(() => bridge.addTrustEntity({ kind: draft.kind, name: draft.name.trim(), relationship: draft.relationship.trim(), aliases: [], channels }),
      () => setDraft({ kind: draft.kind, name: '', relationship: '', email: '', phone: '', website: '' }))
  }
  const entry = (entity: TrustEntity) => <li key={entity.id} className="trust-entity">
    {editing?.id === entity.id ? <form className="settings-form" onSubmit={(event) => {
      event.preventDefault()
      void run(() => bridge.updateTrustEntity({ id: entity.id, name: editing.name.trim(), relationship: editing.relationship.trim(),
        aliases: editing.aliases.split(',').map((alias) => alias.trim()).filter(Boolean) }), () => setEditing(null))
    }}>
      <label>Name<input value={editing.name} maxLength={80} disabled={busy} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
      <label>Relationship<input value={editing.relationship} maxLength={80} disabled={busy} onChange={(event) => setEditing({ ...editing, relationship: event.target.value })} /></label>
      <label>Also known as (comma separated)<input value={editing.aliases} disabled={busy} onChange={(event) => setEditing({ ...editing, aliases: event.target.value })} /></label>
      <div className="trust-row"><button className="primary-button" type="submit" disabled={busy || !editing.name.trim()}>Save</button>
        <button className="text-button" type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div>
    </form> : <div className="trust-row">
      <strong>{entity.name}</strong>
      <span className="field-hint">{[entity.relationship, entity.aliases.length ? 'also ' + entity.aliases.join(', ') : '', SOURCE_LABEL[entity.source]].filter(Boolean).join(' · ')}</span>
      <button className="text-button" disabled={busy} onClick={() => setEditing({ id: entity.id, name: entity.name, relationship: entity.relationship, aliases: entity.aliases.join(', ') })}>Edit</button>
      <button className="text-button danger" disabled={busy} onClick={() => void run(() => bridge.deleteTrustEntity(entity.id))}>Delete</button>
    </div>}
    <ul className="trust-channels">
      {entity.channels.map((channel) => <li key={channel.id}>
        <span>{CHANNEL_LABEL[channel.type]}: {channel.type === 'phone' ? phone(channel.value) : channel.value}</span>
        <button className="text-button danger" disabled={busy} aria-label={`Remove ${CHANNEL_LABEL[channel.type].toLowerCase()} ${channel.value}`}
          onClick={() => void run(() => bridge.deleteTrustChannel(channel.id))}>Remove</button>
      </li>)}
      {adding?.id === entity.id ? <li><form className="trust-row" onSubmit={(event) => {
        event.preventDefault()
        void run(() => bridge.addTrustChannel({ entityId: entity.id, channel: { type: adding.type, value: adding.value.trim() } }), () => setAdding(null))
      }}>
        <select value={adding.type} disabled={busy} aria-label="Kind of contact detail" onChange={(event) => setAdding({ ...adding, type: event.target.value as ChannelType })}>
          <option value="email">Email</option><option value="phone">Phone</option><option value="website">Website</option></select>
        <input value={adding.value} maxLength={320} disabled={busy} aria-label="Contact detail" onChange={(event) => setAdding({ ...adding, value: event.target.value })} />
        <button className="primary-button" type="submit" disabled={busy || !adding.value.trim()}>Add</button>
        <button className="text-button" type="button" disabled={busy} onClick={() => setAdding(null)}>Cancel</button>
      </form></li> : <li><button className="text-button" disabled={busy} onClick={() => setAdding({ id: entity.id, type: 'email', value: '' })}>Add email, phone or website</button></li>}
    </ul>
  </li>

  return <section className="trust-settings" aria-label="People and organizations">
    <h3>People &amp; organizations</h3>
    <p className="field-hint">The people and organizations you really deal with, and how they really reach you. Triage warns you when a message or page claims to be one of them but comes from somewhere else. Only what you or a caregiver enter here, or what you tell Triage and confirm, is ever trusted. This list stays on this Mac.</p>
    {graph ? <>
      <h4>People</h4>
      <ul className="trust-list">{graph.entities.filter((entity) => entity.kind === 'person').map(entry)}</ul>
      {!graph.entities.some((entity) => entity.kind === 'person') && <p className="field-hint">No people yet.</p>}
      <h4>Organizations</h4>
      <ul className="trust-list">{graph.entities.filter((entity) => entity.kind === 'organization').map(entry)}</ul>
      <form className="settings-form" onSubmit={add}>
        <h4>Add someone</h4>
        <label htmlFor="trust-kind">Person or organization</label>
        <select id="trust-kind" value={draft.kind} disabled={busy} onChange={(event) => setDraft({ ...draft, kind: event.target.value as EntityKind })}>
          <option value="person">Person</option><option value="organization">Organization</option></select>
        <label htmlFor="trust-name">Name</label>
        <input id="trust-name" value={draft.name} maxLength={80} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <label htmlFor="trust-relationship">Relationship (optional)</label>
        <input id="trust-relationship" value={draft.relationship} maxLength={80} placeholder="son, doctor, bank…" disabled={busy} onChange={(event) => setDraft({ ...draft, relationship: event.target.value })} />
        <label htmlFor="trust-email">Their real email (optional)</label>
        <input id="trust-email" type="email" value={draft.email} maxLength={320} disabled={busy} onChange={(event) => setDraft({ ...draft, email: event.target.value })} />
        <label htmlFor="trust-phone">Their real phone number (optional)</label>
        <input id="trust-phone" type="tel" value={draft.phone} maxLength={40} disabled={busy} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} />
        <label htmlFor="trust-website">Their real website (optional)</label>
        <input id="trust-website" value={draft.website} maxLength={253} placeholder="example.com" disabled={busy} onChange={(event) => setDraft({ ...draft, website: event.target.value })} />
        <button className="primary-button" type="submit" disabled={busy || !draft.name.trim()}>Add to list</button>
      </form>
      {graph.decisions.length > 0 && <>
        <h4>What you told Triage</h4>
        <ul className="trust-list">{graph.decisions.map((decision) => <li key={decision.id} className="trust-row">
          <span>{decision.verdict === 'scam' ? 'Scam' : 'Really them'}: {decision.channelValue}{decision.claimedName ? ` (said to be ${decision.claimedName})` : ''}</span>
          <button className="text-button danger" disabled={busy} onClick={() => void run(() => bridge.deleteTrustDecision(decision.id))}>Forget</button>
        </li>)}</ul>
      </>}
    </> : !error && <p className="loading-note">Loading your list…</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>
}
