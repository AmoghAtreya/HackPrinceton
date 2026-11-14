import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { TranscriptRecord, VoiceBridge } from '../../shared/voice-contracts'
import { displayError, unwrap } from './assistant-ui'
import { MicrophoneCapture, MicrophoneProblem } from './voice/microphone'
import { speechPlayer, type PlaybackSnapshot } from './voice/speech-player'

type Phase = 'idle' | 'starting' | 'recording' | 'finishing'

/** Presses shorter than this become "tap to start, tap again to stop". */
const TAP_MS = 400

/**
 * Hold to talk (or tap to start / tap to stop). Streams the microphone to
 * Amazon Transcribe through the main process and shows live captions.
 * The finished transcript is stored by the main process; nothing is sent to
 * the assistant yet.
 */
export function VoiceButton({ bridge, onTranscript }: { bridge: VoiceBridge; onTranscript?: (record: TranscriptRecord) => void }) {
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [caption, setCaption] = useState('')
  const [level, setLevel] = useState(0)
  const [last, setLast] = useState<TranscriptRecord | null>(null)
  const [error, setError] = useState('')
  const [playback, setPlayback] = useState<PlaybackSnapshot>(speechPlayer.snapshot())
  const phaseRef = useRef<Phase>('idle')
  const session = useRef<string | null>(null)
  const microphone = useRef<MicrophoneCapture | null>(null)
  const stopRequested = useRef(false)
  /** Bumped by cancel so a start that is still in flight knows to back out. */
  const attempt = useRef(0)
  const pressedAt = useRef(0)
  const tapMode = useRef(false)
  const finals = useRef(new Map<string, string>())
  const partial = useRef('')
  const transcriptListener = useRef(onTranscript)
  transcriptListener.current = onTranscript

  function setPhase(next: Phase) { phaseRef.current = next; setPhaseState(next) }

  function renderCaption() {
    setCaption([...finals.current.values(), partial.current].filter(Boolean).join(' '))
  }

  async function begin() {
    if (phaseRef.current !== 'idle') return
    setPhase('starting'); setError(''); setLevel(0)
    stopRequested.current = false
    finals.current.clear(); partial.current = ''; setCaption('')
    const mine = ++attempt.current
    let id: string | null = null
    try {
      const receipt = unwrap(await bridge.startVoice())
      id = receipt.sessionId
      if (attempt.current !== mine) { void bridge.cancelVoice(id); return }
      session.current = id
      const mic = new MicrophoneCapture()
      microphone.current = mic
      const sessionId = receipt.sessionId
      await mic.start(receipt.sampleRate, (chunk, value) => {
        if (session.current === sessionId) { bridge.sendVoiceAudio(sessionId, chunk); setLevel(value) }
      })
      if (attempt.current !== mine) { await mic.stop(); return }
      setPhase('recording')
      if (stopRequested.current) await end()
    } catch (problem) {
      if (id) void bridge.cancelVoice(id)
      if (attempt.current !== mine) return
      session.current = null; microphone.current = null
      setPhase('idle')
      setError(problem instanceof MicrophoneProblem ? problem.message : displayError(problem))
    }
  }

  async function end() {
    if (phaseRef.current === 'starting') { stopRequested.current = true; return }
    if (phaseRef.current !== 'recording') return
    const id = session.current
    setPhase('finishing'); setLevel(0)
    try {
      await microphone.current?.stop()
      microphone.current = null
      if (!id) return
      const record = unwrap(await bridge.finishVoice(id))
      setLast(record)
      if (record.error) setError(record.error)
      else if (!record.text) setError('I didn’t catch anything. Try again a little closer to the microphone.')
      transcriptListener.current?.(record)
    } catch (problem) {
      setError(displayError(problem))
    } finally {
      session.current = null
      setCaption('')
      setPhase('idle')
    }
  }

  async function cancel() {
    if (phaseRef.current === 'finishing') return
    attempt.current++
    const id = session.current
    const mic = microphone.current
    stopRequested.current = false
    session.current = null
    microphone.current = null
    setPhase('idle'); setLevel(0); setCaption('')
    await mic?.stop()
    if (id) void bridge.cancelVoice(id)
  }

  function press() {
    // Never record Triage's own voice: stop any reply before the microphone opens.
    speechPlayer.stop()
    pressedAt.current = Date.now()
    if (phaseRef.current === 'idle') { tapMode.current = false; void begin() }
    else if (tapMode.current && (phaseRef.current === 'recording' || phaseRef.current === 'starting')) void end()
  }

  function release() {
    if (phaseRef.current !== 'recording' && phaseRef.current !== 'starting') return
    if (tapMode.current) return
    if (Date.now() - pressedAt.current < TAP_MS) { tapMode.current = true; return }
    void end()
  }

  useEffect(() => speechPlayer.subscribe(setPlayback), [])

  useEffect(() => {
    const offState = bridge.onSpeechState((message) => {
      // The main process ended the recording itself (time limit, AWS error, sleep).
      if (message.state !== 'listening' && phaseRef.current === 'recording') {
        if (message.error) setError(message.error)
        void end()
      } else if (message.state === 'idle' && message.error && phaseRef.current === 'idle') setError(message.error)
    })
    const offUtterance = bridge.onUtterance((utterance) => {
      if (utterance.sessionId !== session.current) return
      if (utterance.isFinal) {
        partial.current = ''
        if (utterance.text) finals.current.set(utterance.segmentId, utterance.text)
      } else partial.current = utterance.text
      renderCaption()
    })
    return () => {
      offState(); offUtterance()
      attempt.current++
      const id = session.current
      void microphone.current?.stop()
      if (id) void bridge.cancelVoice(id)
    }
  }, [bridge])

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && phaseRef.current !== 'idle') { event.preventDefault(); void cancel(); return }
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (!event.repeat) press()
  }

  function onKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    release()
  }

  const recording = phase === 'recording'
  const label = phase === 'starting' ? 'Starting microphone…'
    : recording ? (tapMode.current ? 'Listening… tap to stop' : 'Listening… let go to stop')
      : phase === 'finishing' ? 'Writing down what you said…' : 'Hold to talk'

  return <section className="voice-input" aria-label="Voice input">
    <button type="button" className={'talk-button talk-button--' + phase} aria-pressed={recording}
      disabled={phase === 'finishing'}
      onPointerDown={(event) => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); press() } }}
      onPointerUp={release} onPointerCancel={release}
      onKeyDown={onKeyDown} onKeyUp={onKeyUp}>
      <span className="talk-icon" aria-hidden="true">{recording ? '■' : '●'}</span>{label}
    </button>
    {recording && <div className="talk-level" aria-hidden="true"><span style={{ width: Math.min(100, Math.round(level * 400)) + '%' }} /></div>}
    {(phase !== 'idle' || caption) && <p className="voice-caption" aria-live="polite">{caption || (recording ? 'Go ahead, I’m listening.' : '')}</p>}
    {phase === 'idle' && last?.text && !error && <p className="voice-last">Heard: “{last.text}”
      <span className="voice-engine">{last.transcribedBy === 'gemini' ? ' · Gemini' : last.transcribedBy === 'transcribe' ? ' · Amazon Transcribe' : ' · on this Mac'}</span></p>}
    {error && <p className="voice-error" role="alert">{error}</p>}
    {phase !== 'idle' && <button type="button" className="text-button" onClick={() => void cancel()}>Cancel · Esc</button>}
    {phase === 'idle' && playback.state !== 'idle' && <div className="speaking-status" role="status">
      <span className="speaking-icon" aria-hidden="true">🔊</span>{playback.state === 'loading' ? 'Getting ready to speak…' : 'Speaking…'}
      <button type="button" className="text-button" onClick={() => speechPlayer.stop()}>Stop</button>
    </div>}
    {phase === 'idle' && playback.state === 'idle' && playback.canReplay &&
      <button type="button" className="text-button say-again" onClick={() => void speechPlayer.replay()}>
        <span aria-hidden="true">↻</span> Say that again</button>}
    {playback.notice && <p className="notice warning voice-notice" role="status">{playback.notice}
      <button type="button" className="text-button" onClick={() => speechPlayer.dismissNotice()}>Dismiss</button></p>}
  </section>
}
