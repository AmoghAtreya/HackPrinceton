import { useEffect, useState } from 'react'
import type { DesktopBridge } from '../../shared/contracts'
import type { TrustState } from '../../shared/trust-contracts'
import { displayError, unwrap } from './assistant-ui'

/** The warning shown when what is on screen claims to be someone the user knows but does not match their list. */
export function TrustWarning({ bridge }: { bridge: DesktopBridge }) {
  const [state, setState] = useState<TrustState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    const off = bridge.onTrustState((next) => { if (mounted) { setState(next); setError('') } })
    bridge.getTrustState().then((result) => { if (mounted && result.ok) setState(result.value) }).catch(() => {})
    return () => { mounted = false; off() }
  }, [bridge])
  const warning = state?.warning
  if (!warning) return null
  async function act(action: () => Promise<{ ok: true; value: TrustState } | { ok: false; error: { code: string; message: string } }>) {
    setBusy(true); setError('')
    try { setState(unwrap(await action())) }
    catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }
  return <section className={'trust-warning ' + warning.level} role="alert" aria-label="Possible impersonation">
    <strong>{warning.level === 'reported_scam' ? 'Scam you reported' : 'Check before you trust this'}</strong>
    <p className="trust-message">{warning.message}</p>
    <details>
      <summary>Why Triage says this</summary>
      <ul>{warning.facts.map((fact, index) => <li key={index}>{fact}</li>)}</ul>
    </details>
    <div className="trust-actions">
      {warning.canDecide && <>
        <button className="primary-button" disabled={busy} onClick={() => void act(() => bridge.decideTrust({ key: warning.key, verdict: 'scam' }))}>This is a scam</button>
        <button className="text-button" disabled={busy} onClick={() => void act(() => bridge.decideTrust({ key: warning.key, verdict: 'genuine' }))}>It’s really them</button>
      </>}
      <button className="text-button" disabled={busy} onClick={() => void act(() => bridge.dismissTrustWarning())}>Hide</button>
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>
}
