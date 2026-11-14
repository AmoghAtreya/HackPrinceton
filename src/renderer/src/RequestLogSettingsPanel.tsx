import { useEffect, useState } from 'react'
import type { DesktopBridge } from '../../shared/contracts'
import type { RequestLogSettings } from '../../shared/request-log-contracts'
import { displayError, unwrap } from './assistant-ui'

/** "Help improve Triage": opt-in sharing of questions (never screenshots or audio). */
export function RequestLogSettingsPanel({ bridge }: { bridge: DesktopBridge }) {
  const [settings, setSettings] = useState<RequestLogSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let mounted = true
    bridge.getRequestLogSettings().then((result) => { if (mounted) setSettings(unwrap(result)) })
      .catch((problem) => { if (mounted) setError(displayError(problem)) })
    return () => { mounted = false }
  }, [bridge])

  async function run(action: () => Promise<RequestLogSettings>, message: (saved: RequestLogSettings) => string) {
    setBusy(true); setError(''); setNotice('')
    try { const saved = await action(); setSettings(saved); setNotice(message(saved)) }
    catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }

  return <section className="request-log-settings" aria-label="Help improve Triage">
    <h3>Help improve Triage</h3>
    <p className="field-hint">Share the questions you ask (typed or spoken) so we can learn which help people need most and add common answers and shortcuts.
      Screenshots and voice recordings are never shared. This is off unless you turn it on.</p>
    {settings ? <>
      <label className="checkbox-label"><input type="checkbox" checked={settings.shareRequests} disabled={busy}
        onChange={(event) => void run(async () => unwrap(await bridge.saveRequestLogSettings({ shareRequests: event.target.checked })),
          (saved) => saved.shareRequests ? 'Thank you. Your questions will be shared.' : 'Sharing is off.')} />Share my questions</label>
      <p className="field-hint">{settings.pending === 0 ? 'Nothing is saved for sharing.' : `${settings.pending} question${settings.pending === 1 ? '' : 's'} saved on this Mac for sharing.`}
        {' '}For now, shared questions stay on this Mac. When uploading is added, personal details such as names and account numbers will be removed before anything is stored.</p>
      <button type="button" className="text-button danger" disabled={busy || settings.pending === 0}
        onClick={() => void run(async () => unwrap(await bridge.clearRequestLog()), () => 'Your shared questions were deleted.')}>Delete my shared questions</button>
    </> : !error && <p className="loading-note">Loading…</p>}
    {settings?.warning && <p className="notice warning">{settings.warning}</p>}
    {notice && <p className="notice success" role="status">{notice}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>
}
