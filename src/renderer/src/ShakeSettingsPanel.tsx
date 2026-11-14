import { useEffect, useState, type FormEvent } from 'react'
import type { DesktopBridge } from '../../shared/contracts'
import { DEFAULT_SHAKE_INSTRUCTION, type ShakeSettings } from '../../shared/shake-contracts'
import { displayError, unwrap } from './assistant-ui'

export function ShakeSettingsPanel({ bridge }: { bridge: DesktopBridge }) {
  const [settings, setSettings] = useState<ShakeSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let mounted = true
    bridge.getShakeSettings().then((result) => {
      if (mounted) setSettings(unwrap(result))
    }).catch((problem) => { if (mounted) setError(displayError(problem)) })
    return () => { mounted = false }
  }, [bridge])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const saved = unwrap(await bridge.saveShakeSettings({ enabled: settings.enabled, instruction: settings.instruction, ...(settings.mode ? { mode: settings.mode } : {}) }))
      setSettings(saved)
      setNotice(saved.enabled ? 'Shake to Help is on.' : 'Shake to Help is off.')
    } catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }
  return <section className="shake-settings" aria-label="Shake to Help settings">
    <h3>Shake to Help</h3>
    <p className="field-hint">Move your cursor back and forth quickly to run one saved instruction near the cursor.</p>
    <p className="notice warning">When enabled, each deliberate shake automatically captures the entire display under your cursor and sends it with this instruction to your AI provider. API usage may incur charges. There is no preview step for shakes.</p>
    {settings ? <form className="settings-form" onSubmit={save}>
      <label className="checkbox-label"><input type="checkbox" checked={settings.enabled} disabled={busy}
        onChange={(event) => { setSettings({ ...settings, enabled: event.target.checked }); setNotice('') }} />Enable Shake to Help</label>
      <label htmlFor="shake-action">Shake action</label>
      <select id="shake-action" value={settings.mode ?? 'explain'} disabled={busy} onChange={(event) => {
        setSettings({ ...settings, mode: event.target.value as 'explain' | 'highlight' }); setNotice('')
      }}><option value="explain">Explain the screen</option><option value="highlight">Show me where</option></select>
      <label htmlFor="shake-instruction">Saved shake instruction</label>
      <textarea id="shake-instruction" rows={3} maxLength={4000} disabled={busy} value={settings.instruction}
        onChange={(event) => { setSettings({ ...settings, instruction: event.target.value }); setNotice('') }} />
      <p className="field-hint">Saved locally as text. Avoid secrets. Instructions explain the screen or briefly mark a visible control; they cannot run code or control apps. A key and screen permission are required.</p>
      <div className="shake-actions">
        <button className="primary-button" type="submit" disabled={busy || !settings.instruction.trim()}>{busy ? 'Saving…' : 'Save shake settings'}</button>
        <button className="text-button" type="button" disabled={busy} onClick={() => {
          setSettings({ enabled: false, instruction: DEFAULT_SHAKE_INSTRUCTION }); setNotice('Default restored. Save to apply.')
        }}>Reset to default</button>
      </div>
      {settings.warning && <p className="notice warning">{settings.warning}</p>}
    </form> : !error && <p className="loading-note">Loading shake settings…</p>}
    <p className="field-hint">A three-second cooldown limits repeats. Dragging Triage pauses detection; busy shakes are skipped and recorded in History. Switching this off stops future triggers; use Stop for a running request.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {notice && <p className="notice success" role="status">{notice}</p>}
  </section>
}
