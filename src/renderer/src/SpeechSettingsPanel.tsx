import { useEffect, useState, type FormEvent } from 'react'
import type { DesktopBridge } from '../../shared/contracts'
import { speechRates, speechVoices, type ReadAloud, type SpeechRate, type SpeechSettings, type SpeechVoice } from '../../shared/speech-contracts'
import { displayError, unwrap } from './assistant-ui'
import { speechPlayer } from './voice/speech-player'

const readAloudLabels: Record<ReadAloud, string> = {
  voice: 'When I speak or shake',
  always: 'Always',
  off: 'Never'
}
const rateLabels: Record<SpeechRate, string> = { 80: 'Slower', 90: 'Relaxed', 100: 'Normal', 115: 'Faster' }

export function SpeechSettingsPanel({ bridge }: { bridge: DesktopBridge }) {
  const [settings, setSettings] = useState<SpeechSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [voiceKey, setVoiceKey] = useState('')
  const [rememberVoiceKey, setRememberVoiceKey] = useState(true)

  useEffect(() => {
    let mounted = true
    bridge.getSpeechSettings().then((result) => { if (mounted) setSettings(unwrap(result)) })
      .catch((problem) => { if (mounted) setError(displayError(problem)) })
    return () => { mounted = false }
  }, [bridge])

  async function persist(next: SpeechSettings): Promise<boolean> {
    setBusy(true); setError(''); setNotice('')
    try {
      setSettings(unwrap(await bridge.saveSpeechSettings({ readAloud: next.readAloud, rate: next.rate, voice: next.voice, geminiTranscription: next.geminiTranscription })))
      return true
    } catch (problem) { setError(displayError(problem)); return false }
    finally { setBusy(false) }
  }

  async function saveVoiceKey(event: FormEvent) {
    event.preventDefault()
    if (!voiceKey.trim() || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      setSettings(unwrap(await bridge.setGeminiVoiceKey({ key: voiceKey.trim(), remember: rememberVoiceKey })))
      setVoiceKey('')
      setNotice('Gemini voice key saved. Your chatbot key is unchanged.')
    } catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }

  async function removeVoiceKey() {
    setBusy(true); setError(''); setNotice('')
    try { setSettings(unwrap(await bridge.removeGeminiVoiceKey())); setNotice('Gemini voice key removed.') }
    catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (settings && !busy && await persist(settings)) setNotice('Voice reply settings saved.')
  }

  async function test() {
    // Save first so the test uses the chosen voice and speed.
    if (!settings || busy || !await persist(settings)) return
    void speechPlayer.speak(`Hello, I'm Triage. This is how I'll read my answers to you.`)
  }

  return <section className="speech-settings" aria-label="Voice settings">
    <h3>Voice input</h3>
    {settings && <div className="settings-form">
      <label className="checkbox-label"><input type="checkbox" checked={settings.geminiTranscription} disabled={busy}
        onChange={(event) => void persist({ ...settings, geminiTranscription: event.target.checked }).then((saved) => {
          if (saved) setNotice(event.target.checked ? 'Gemini will write down what you say.' : 'Voice now stays entirely on this Mac.')
        })} />More accurate voice with Google Gemini</label>
      <p className="field-hint">Live captions always stay on this Mac. With this on, when you let go of the talk button the recording is sent to
        Google Gemini to write down exactly what you said. Without internet or a Gemini key, Triage uses this Mac’s own transcript.</p>
      {settings.geminiTranscription && <p className={settings.geminiKeyAvailable ? 'field-hint' : 'notice warning'}>
        {settings.geminiKeySource === 'voice' ? 'Voice uses your Gemini voice key.'
          : settings.geminiKeySource === 'chatbot' ? 'Voice uses your Gemini chatbot key. Add a voice key below to keep a different chatbot (like Claude).'
            : settings.geminiKeySource === 'env' ? 'Voice uses the GEMINI_API_KEY environment variable.'
              : 'No Gemini key yet. Add one below; until then voice stays on this Mac.'}</p>}
    </div>}
    {settings && <form className="settings-form" onSubmit={saveVoiceKey}>
      <label htmlFor="gemini-voice-key">Gemini key for voice (transcription only)</label>
      <input id="gemini-voice-key" type="password" autoComplete="off" spellCheck={false} maxLength={512} disabled={busy}
        placeholder={settings.geminiVoiceKey === 'encrypted' || settings.geminiVoiceKey === 'session' ? 'Enter a replacement key…' : 'Paste a key from aistudio.google.com/apikey…'}
        value={voiceKey} onChange={(event) => setVoiceKey(event.target.value)} />
      <label className="checkbox-label"><input type="checkbox" checked={rememberVoiceKey} disabled={busy}
        onChange={(event) => setRememberVoiceKey(event.target.checked)} />Remember on this Mac</label>
      <p className="field-hint">Used only to write down what you say. Your chatbot key above stays as it is.
        {settings.geminiVoiceKey === 'encrypted' ? ' Saved, encrypted on this Mac.' : settings.geminiVoiceKey === 'session' ? ' Saved until you quit Triage.'
          : settings.geminiVoiceKey === 'locked' ? ' The saved key could not be unlocked; add it again.' : ''}</p>
      <div className="speech-actions">
        <button className="primary-button" type="submit" disabled={busy || voiceKey.trim().length < 20}>Save voice key</button>
        {(settings.geminiVoiceKey === 'encrypted' || settings.geminiVoiceKey === 'session' || settings.geminiVoiceKey === 'locked') &&
          <button className="text-button danger" type="button" disabled={busy} onClick={() => void removeVoiceKey()}>Remove voice key</button>}
      </div>
    </form>}
    <h3>Voice replies</h3>
    <p className="field-hint">Triage can read its answers aloud with Amazon Polly. If Polly isn't available, this Mac's built-in voice is used.</p>
    {settings ? <form className="settings-form" onSubmit={save}>
      <label htmlFor="speech-read-aloud">Read replies aloud</label>
      <select id="speech-read-aloud" value={settings.readAloud} disabled={busy}
        onChange={(event) => { setSettings({ ...settings, readAloud: event.target.value as ReadAloud }); setNotice('') }}>
        {(Object.keys(readAloudLabels) as ReadAloud[]).map((value) => <option key={value} value={value}>{readAloudLabels[value]}</option>)}
      </select>
      <label htmlFor="speech-rate">Speaking speed</label>
      <select id="speech-rate" value={settings.rate} disabled={busy}
        onChange={(event) => { setSettings({ ...settings, rate: Number(event.target.value) as SpeechRate }); setNotice('') }}>
        {speechRates.map((value) => <option key={value} value={value}>{rateLabels[value]}</option>)}
      </select>
      <label htmlFor="speech-voice">Voice</label>
      <select id="speech-voice" value={settings.voice} disabled={busy}
        onChange={(event) => { setSettings({ ...settings, voice: event.target.value as SpeechVoice }); setNotice('') }}>
        {speechVoices.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
      </select>
      <div className="speech-actions">
        <button className="primary-button" type="submit" disabled={busy}>Save voice settings</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void test()}>Test voice</button>
      </div>
    </form> : !error && <p className="loading-note">Loading voice settings…</p>}
    {settings?.warning && <p className="notice warning">{settings.warning}</p>}
    {notice && <p className="notice success" role="status">{notice}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>
}
