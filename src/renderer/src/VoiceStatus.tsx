import { useEffect, useState } from 'react'
import type { DesktopBridge } from '../../shared/contracts'
import type { VoiceState } from '../../shared/voice-contracts'

/** This view lives in a non-focusable window. It never selects a conversation. */
export function VoiceStatus({ bridge }: { bridge: DesktopBridge }) {
  const [voice, setVoice] = useState<VoiceState | null>(null)
  useEffect(() => {
    let mounted = true
    let received = false
    const off = bridge.onVoiceState((next) => { received = true; if (mounted) setVoice(next) })
    void bridge.getVoiceState().then((result) => {
      if (mounted && !received && result.ok) setVoice(result.value)
    })
    return () => { mounted = false; off() }
  }, [bridge])
  return <main style={{ padding: 18, height: '100vh', overflow: 'auto', background: '#faf8f3', color: '#292820' }} aria-label="Global voice input">
    <strong>Triage · {voice?.input === 'listening' ? '● Listening — release to send' : voice?.input === 'starting' ? (voice.sessionId ? 'Starting microphone…' : 'Checking speech availability…') : voice?.input ?? 'Voice'}</strong>
    <p role="status" aria-live="polite">{voice?.notice}</p>
    <small>{voice?.conversationTitle} · {voice?.shortcut?.chord ?? 'Global talk unavailable'}</small>
    {voice?.input === 'listening' && <p><meter aria-label="Microphone level" min={0} max={1} value={voice.level} /></p>}
    {voice?.provisional && <p><em>Provisional: {voice.provisional}</em></p>}
    {voice?.draft && <p>Unsent recovery draft available in chat.</p>}
    <div className="voice-actions">
      {voice?.sessionId && <button onClick={() => void bridge.cancelVoice(voice.sessionId!)}>Cancel recording</button>}
      <button onClick={() => void bridge.stopVoice()}>Stop</button>
    </div>
  </main>
}
