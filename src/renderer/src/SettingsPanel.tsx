import { useState, type FormEvent } from 'react'
import type { DesktopBridge } from '../../shared/contracts'
import type { PublicConfig } from '../../shared/assistant-contracts'
import { displayError, unwrap } from './assistant-ui'
import { ShakeSettingsPanel } from './ShakeSettingsPanel'
import { TrustPanel } from './TrustPanel'
import { SpeechSettingsPanel } from './SpeechSettingsPanel'
import { RequestLogSettingsPanel } from './RequestLogSettingsPanel'

export function SettingsPanel({ bridge, config, active }: {
  bridge: DesktopBridge; config: PublicConfig; active: boolean
}) {
  const [key, setKey] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function connect(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      unwrap(await bridge.connectKey({ key: key.trim(), remember }))
      setNotice('Connected. Choose a model below, then return to Chat.')
    } catch (problem) { setError(displayError(problem)) }
    finally { setKey(''); setBusy(false) }
  }

  async function select(model: string) {
    setBusy(true); setError('')
    try { unwrap(await bridge.selectModel(model)) }
    catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }

  async function setFast(enabled: boolean) {
    setBusy(true); setError('')
    try { unwrap(await bridge.setFastModel(enabled)) }
    catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }

  async function remove() {
    setBusy(true); setError(''); setNotice('')
    try { unwrap(await bridge.removeKey()); setNotice('Your key has been removed from Triage.') }
    catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }

  return <section className="settings-view">
    <span className="eyebrow">MAKE TRIAGE YOURS</span>
    <h2>Connect your AI</h2>
    <p className="section-description">Paste a free Google Gemini key from aistudio.google.com/apikey. Gemini Flash answers quickly, which suits short everyday requests. An Anthropic (Claude) key also works; Triage picks the provider from the key. Your key never appears in saved conversations.</p>
    <div className="connection-status"><i className={config.configured ? 'connected' : ''} />
      {config.configured ? `Connected · ${config.keyStorage === 'session' ? 'this session only' : 'encrypted on this Mac'}` : 'Not connected'}
    </div>
    {config.warning && <p className="notice warning" role="status">{config.warning}</p>}
    <form className="settings-form" onSubmit={connect}>
      <label htmlFor="api-key">Gemini API key (or Anthropic)</label>
      <input id="api-key" type="password" autoComplete="off" spellCheck={false}
        placeholder={config.configured ? 'Enter a replacement key…' : 'Paste your API key…'}
        value={key} maxLength={512} onChange={(event) => setKey(event.target.value)} disabled={busy || active} />
      <label className="checkbox-label"><input type="checkbox" checked={remember} disabled={busy || active}
        onChange={(event) => setRemember(event.target.checked)} />Remember on this Mac</label>
      <p className="field-hint">Unchecked: memory only until you quit. Checked: encrypted using macOS secure storage. Development builds may require a session-only key.</p>
      <button className="primary-button" type="submit" disabled={key.trim().length < 20 || busy || active}>
        {busy ? 'Connecting…' : config.configured ? 'Reconnect key' : 'Connect key'}
      </button>
    </form>
    {error && <p className="notice error" role="alert">{error}</p>}
    {notice && <p className="notice success" role="status">{notice}</p>}
    <div className="model-setting">
      <label htmlFor="model">Model</label>
      <select id="model" value={config.model} disabled={!config.models.length || busy || active}
        onChange={(event) => void select(event.target.value)}>
        {!config.models.length && <option value="">Connect to load available models</option>}
        {config.models.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
      </select>
      <p className="field-hint">Models are loaded from your provider for this key. For Gemini, “Gemini Flash Latest” is the quickest and always current. API usage may incur charges; check your account’s pricing.</p>
      <label className="checkbox-label"><input type="checkbox" checked={config.fastModel} disabled={busy || active}
        onChange={(event) => void setFast(event.target.checked)} />Use faster model for simple requests</label>
      <p className="field-hint">On: ordinary chat replies and routing use a Haiku model when your key has one. Screenshots, “show me where” and page simplifying use the model chosen above, or a Sonnet model if you chose Haiku.</p>
    </div>
    {(config.configured || config.keyStorage === 'locked') &&
      <button className="text-button danger" disabled={busy || active} onClick={() => void remove()}>Remove key from Triage</button>}
    <SpeechSettingsPanel bridge={bridge} />
    <TrustPanel bridge={bridge} />
    <ShakeSettingsPanel bridge={bridge} />
    <RequestLogSettingsPanel bridge={bridge} />
    <div className="privacy-note">
      <strong>Your data</strong>
      <p>Messages and recent context go to your AI provider (Anthropic or Google) for replies. Conversations are saved unencrypted on this Mac. Recognized keys and tokens are redacted, but avoid sharing secrets.</p>
      <p>Each chat message also carries a short text description of the app in front: its name, window title, website name and the labels of visible buttons and fields, never what you typed into them. If that is not enough to answer, Triage may take one screenshot, with password and card fields blacked out, and send it. Your list of people and organizations stays on this Mac. When it is relevant, the AI is told a contact’s name and relationship and a partly hidden hint (such as the first letter of an email), never the full address or number. Triage uses a bounded recent context, not your entire saved history. Screen capture is available from Chat: preview locally, then explicitly send it for explanation. With Shake to Help enabled, a shake sends a screen capture automatically using your saved instruction. Images are not saved. Alaska flight searches run in a separate visible browser; Triage never selects a fare or purchases a ticket.</p>
      <p>Voice input is turned into live captions on this Mac. If “More accurate voice with Google Gemini” is on, the finished recording is also sent to Google Gemini for the final transcript. Spoken replies are sent to Amazon Polly to generate audio. Transcripts are saved unencrypted on this Mac; audio is not saved.</p>
    </div>
  </section>
}
