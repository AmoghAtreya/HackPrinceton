import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { DesktopBridge } from '../../shared/contracts'
import type { VoiceSettings, VoiceState } from '../../shared/voice-contracts'
import { displayError, unwrap } from './assistant-ui'

export function VoiceSettingsPanel({ bridge, controlsOnly = false }: { bridge: DesktopBridge; controlsOnly?: boolean }) {
  const [voice, setVoice] = useState<VoiceState | null>(null)
  const [settings, setSettings] = useState<VoiceSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const current = useRef<VoiceState | null>(null)
  const lastDraft = useRef('')
  useEffect(() => {
    let mounted = true
    let received = false
    const accept = (next: VoiceState) => {
      if (!mounted) return
      if (!current.current || JSON.stringify(current.current.settings) !== JSON.stringify(next.settings)) setSettings(next.settings)
      current.current = next
      setVoice(next)
      if (next.draft !== lastDraft.current) { lastDraft.current = next.draft; setDraft(next.draft) }
    }
    const off = bridge.onVoiceState((next) => { received = true; accept(next) })
    bridge.getVoiceState().then((result) => {
      const next = unwrap(result)
      if (mounted && !received) accept(next)
    }).catch((problem) => { if (mounted) setError(displayError(problem)) })
    const escape = (event: KeyboardEvent) => {
      const id = current.current?.sessionId
      if (event.key === 'Escape' && id) {
        event.preventDefault(); event.stopImmediatePropagation()
        void bridge.cancelVoice(id)
      }
    }
    window.addEventListener('keydown', escape, true)
    return () => {
      mounted = false; off(); window.removeEventListener('keydown', escape, true)
      const id = current.current?.sessionId
      if (id && current.current?.activation !== 'hold') void bridge.cancelVoice(id)
    }
  }, [bridge])
  async function run(action: () => ReturnType<DesktopBridge['getVoiceState']>) {
    setBusy(true); setError('')
    try { unwrap(await action()) }
    catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (settings) void run(() => bridge.saveVoiceSettings(settings))
  }
  const recording = Boolean(voice?.sessionId)
  return <section className="voice-settings" aria-label={controlsOnly ? 'Voice input' : 'Voice settings'}>
    <h3>{controlsOnly ? 'Talk to Triage' : 'Voice · hold or click to talk'}</h3>
    {!controlsOnly && <><p className="notice warning">Audio is captured only while you hold the talk shortcut or after you click Start, until release, Finish, Cancel or the 45-second limit. Wait for Listening before speaking. Apple Speech must run on this Mac; server recognition is rejected. Audio and provisional text are never saved. Finish sends final speech to your assistant conversation and Anthropic using the same model and history as typed chat. Cancel discards it. Screen requests and spoken replies arrive later.</p>
    <p className="field-hint">Setup asks for Microphone and Speech Recognition for Triage Voice Helper. Apple’s permission wording may mention servers; Triage requires on-device recognition. Global talk additionally asks for Input Monitoring to detect shortcut release. Only chord events are used; general keystrokes are never recorded. Denying this permission leaves click-to-talk available.</p>
    </>}
    {!controlsOnly && settings && <form className="settings-form" onSubmit={save}>
      <label className="checkbox-label"><input type="checkbox" checked={settings.enabled} disabled={busy || recording}
        onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />Enable voice</label>
      <label htmlFor="voice-microphone">Microphone</label>
      <select id="voice-microphone" value={settings.microphoneId ?? ''} disabled={busy || recording}
        onChange={(event) => setSettings({ ...settings, microphoneId: event.target.value || null })}>
        <option value="">System default</option>
        {settings.microphoneId && !voice?.availability?.devices.some((device) => device.id === settings.microphoneId) &&
          <option value={settings.microphoneId}>Saved microphone · unavailable</option>}
        {voice?.availability?.devices.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
      </select>
      <label htmlFor="voice-shortcut">Talk shortcut</label>
      <input id="voice-shortcut" value={settings.shortcut} maxLength={64} disabled={busy || recording}
        onChange={(event) => setSettings({ ...settings, shortcut: event.target.value })} />
      <p className="field-hint">Example: Control+Option+Space. A conflicting replacement keeps the previous binding. Release every chord key before a fresh hold.</p>
      <label className="checkbox-label"><input type="checkbox" checked={false} disabled />Spoken replies · coming later</label>
      <label className="checkbox-label"><input type="checkbox" checked={false} disabled />Allow voice screen capture · coming later</label>
      <button className="primary-button" type="submit" disabled={busy || recording}>Save voice settings</button>
    </form>}
    <div className="voice-actions">
      <button className="text-button" disabled={!voice?.settings.enabled || busy || recording || voice.input === 'suspended'}
        onClick={() => void run(() => bridge.setupVoice())}>Set up / Retry permissions</button>
      <button className="primary-button" disabled={busy || !voice?.settings.enabled || !voice.availability || voice.input !== 'ready'}
        onClick={() => void run(() => bridge.startVoice())}>Start talking</button>
      {recording && <>
        <button className="primary-button" disabled={voice?.input !== 'listening'}
          onClick={() => void run(() => bridge.finishVoice(voice!.sessionId!))}>Finish and send</button>
        <button className="text-button" onClick={() => void run(() => bridge.cancelVoice(voice!.sessionId!))}>Cancel (Escape)</button>
      </>}
      {voice?.settings.enabled && <button className="text-button danger"
        onClick={() => void run(() => bridge.saveVoiceSettings({ ...voice.settings, enabled: false }))}>Turn off voice</button>}
    </div>
    {voice && <>
      <p className="field-hint">Global talk: {voice.shortcut?.chord ?? 'not registered'} · {voice.shortcut?.status ?? 'unavailable'}. {voice.shortcut?.notice}</p>
      {voice.input === 'ready' && voice.availability?.available && voice.availability.microphone === 'authorized' && voice.availability.speech === 'authorized' && voice.shortcut?.status === 'registered' && <p>Ready — hold {voice.shortcut.chord} to talk. Microphone released.</p>}
      <p className="field-hint">Conversation: {voice.conversationTitle}</p>
      <p role="status" aria-live="polite"><strong>{voice.input}</strong> · {voice.notice}</p>
      {voice.availability && <p className="field-hint">Microphone: {voice.availability.microphone} · Speech: {voice.availability.speech} · On-device support: {voice.availability.onDevice ? 'yes' : 'no'} · Recognizer: {voice.availability.available ? 'available' : 'unavailable'}</p>}
      {voice.input === 'listening' && <label className="voice-level">Microphone level <meter min={0} max={1} value={voice.level} /></label>}
      {voice.provisional && <p className="voice-provisional"><strong>Provisional transcript</strong><br />{voice.provisional}</p>}
      <label className="voice-draft" htmlFor="voice-draft">Final transcript / recovery draft · unsent</label>
      <textarea id="voice-draft" rows={4} value={draft} disabled={recording} onChange={(event) => setDraft(event.target.value)} />
      <p className="field-hint">Only accepted final requests are saved in chat. This unsent recovery draft stays editable here; copy it into the message box to submit it explicitly. Leaving this view cancels manual recording and discards local edits; a global hold continues without taking focus.</p>
    </>}
    {controlsOnly && !voice?.settings.enabled && <p className="field-hint">Enable voice in Settings first.</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>
}
