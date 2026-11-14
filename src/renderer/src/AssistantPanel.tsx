import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { DesktopBridge, DesktopState } from '../../shared/contracts'
import type { AssistantState, ConversationDetail, ConversationPage } from '../../shared/assistant-contracts'
import type { ScreenPreview } from '../../shared/screen-contracts'
import type { TranscriptRecord } from '../../shared/voice-contracts'
import { Character } from './Character'
import { SettingsPanel } from './SettingsPanel'
import { HistoryPanel } from './HistoryPanel'
import { VoiceButton } from './VoiceButton'
import { matchVoiceIntent, needsConfirmation } from './voice/intents'
import { speechPlayer } from './voice/speech-player'
import { failureSpeech, prepareSpeech } from '../../shared/speech-text'
import type { ReadAloud } from '../../shared/speech-contracts'
import { displayError, unwrap } from './assistant-ui'
import { appendConversations, refreshConversations } from './history-state'

type View = 'chat' | 'history' | 'settings'

export function AssistantPanel({ bridge, state }: { bridge: DesktopBridge; state: DesktopState }) {
  const [assistant, setAssistant] = useState<AssistantState | null>(null)
  const [view, setView] = useState<View>('chat')
  const [capture, setCapture] = useState<ScreenPreview | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [highlightMode, setHighlightMode] = useState(false)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [history, setHistory] = useState<ConversationPage>({ items: [], next: null })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** A gentle, non-error message about voice input (e.g. "Did I hear that right?"). */
  const [voiceNotice, setVoiceNotice] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const keepScroll = useRef(false)
  const lastGesture = useRef<string | undefined>(undefined)
  /** Task ids whose reply should be read aloud when it arrives. */
  const speakTasks = useRef(new Set<string>())
  const readAloud = useRef<ReadAloud>('voice')
  const historyVersion = useRef(0)
  const selection = useRef(selected)
  selection.current = selected

  useEffect(() => {
    let active = true
    let received = false
    const off = bridge.onAssistantState((next) => {
      received = true
      if (active) setAssistant(next)
    })
    bridge.getAssistantState().then((result) => {
      const value = unwrap(result)
      if (active && !received) setAssistant(value)
    }).catch((problem) => { if (active) setError(displayError(problem)) })
    return () => { active = false; off() }
  }, [bridge])

  useEffect(() => {
    // Re-read on every view change so a change saved in Settings applies right away.
    let active = true
    bridge.getSpeechSettings().then((result) => { if (active && result.ok) readAloud.current = result.value.readAloud })
      .catch(() => { /* Keep the default. */ })
    return () => { active = false }
  }, [bridge, view])

  useEffect(() => {
    for (const message of detail?.messages ?? []) {
      if (!speakTasks.current.has(message.taskId)) continue
      if (message.role === 'assistant' && message.status === 'completed') {
        speakTasks.current.delete(message.taskId)
        void speechPlayer.speak(prepareSpeech(message.content))
      } else if (message.role === 'user' && ['failed', 'interrupted', 'stopped'].includes(message.status)) {
        speakTasks.current.delete(message.taskId)
        // The user stopped it themselves, so there is nothing to announce.
        if (message.status !== 'stopped') void speechPlayer.speak(failureSpeech(message.error))
      }
    }
  }, [detail?.messages])

  useEffect(() => {
    const gesture = assistant?.gestureRequest
    if (!gesture || lastGesture.current === gesture.taskId) return
    lastGesture.current = gesture.taskId
    // Shake to Help is hands-free, so its answer is spoken unless replies are muted.
    if (readAloud.current !== 'off') queueSpeech(gesture.taskId)
    setCapture(null); setDetail(null); setSelected(gesture.conversationId); setView('chat'); setError('')
  }, [assistant?.gestureRequest?.taskId])

  useEffect(() => {
    if (!assistant) return
    let active = true
    const version = ++historyVersion.current
    bridge.listConversations({}).then((result) => {
      const page = unwrap(result)
      if (active && version === historyVersion.current) setHistory((current) => refreshConversations(current, page))
    }).catch((problem) => { if (active) setError(displayError(problem)) })
    return () => { active = false }
  }, [bridge, assistant?.revision])

  useEffect(() => {
    if (!selected) { setDetail(null); return }
    let active = true
    bridge.getConversation({ id: selected }).then((result) => {
      const incoming = unwrap(result)
      if (!active) return
      setDetail((previous) => {
        if (previous?.conversation.id !== incoming.conversation.id) return incoming
        const combined = new Map(previous.messages.map((message) => [message.id, message]))
        for (const message of incoming.messages) combined.set(message.id, message)
        const hadEarlier = (previous.messages[0]?.seq ?? Infinity) < (incoming.messages[0]?.seq ?? Infinity)
        return {
          ...incoming,
          activity: [...new Map([...(previous.activity ?? []), ...(incoming.activity ?? [])].map((event) => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq),
          nextActivityBefore: (previous.activity?.[0]?.seq ?? Infinity) < (incoming.activity?.[0]?.seq ?? Infinity) ? previous.nextActivityBefore : incoming.nextActivityBefore,
          messages: [...combined.values()].sort((a, b) => a.seq - b.seq),
          nextBefore: hadEarlier ? previous.nextBefore : incoming.nextBefore
        }
      })
    }).catch((problem) => { if (active) setError(displayError(problem)) })
    return () => { active = false }
  }, [bridge, selected, assistant?.revision])

  useEffect(() => {
    if (view === 'chat' && state.chatOpen) input.current?.focus()
  }, [view, state.chatOpen])

  useEffect(() => {
    if (keepScroll.current) { keepScroll.current = false; return }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    bottom.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' })
  }, [detail?.messages.length, view])

  useEffect(() => {
    if (!capture) return
    const clear = () => { setCapture(null); void bridge.discardScreen() }
    if (view !== 'chat' || !state.chatOpen) { clear(); return }
    const timer = setTimeout(clear, Math.max(0, capture.metadata.capturedAt + 60000 - Date.now()))
    return () => clearTimeout(timer)
  }, [capture, view, state.chatOpen, bridge])

  useEffect(() => { if (!capture) setHighlightMode(false) }, [capture])

  async function captureScreen() {
    setCapturing(true); setError(''); setCapture(null)
    try { setCapture(unwrap(await bridge.captureScreen())) }
    catch (problem) { setError(displayError(problem)) }
    finally { setCapturing(false) }
  }

  function openConversation(id: string) {
    setCapture(null); void bridge.discardScreen()
    if (selected !== id) setDetail(null)
    setSelected(id); setView('chat'); setError(''); setDraft('')
  }

  /** Shared by the Send button and voice input. A spoken message leaves any typed draft alone. */
  async function deliver(text: string, source: 'chat' | 'voice', shot: ScreenPreview | null, mode: 'explain' | 'highlight'): Promise<boolean> {
    setBusy(true); setError(''); setVoiceNotice('')
    try {
      const receipt = unwrap(await bridge.sendMessage({ ...(selected ? { conversationId: selected } : {}), text, source, ...(shot ? { captureId: shot.metadata.id, mode } : {}) }))
      if (readAloud.current === 'always' || (readAloud.current === 'voice' && source === 'voice')) queueSpeech(receipt.taskId)
      setSelected(receipt.conversationId); setCapture(null); setView('chat')
      if (source === 'chat') setDraft('')
      return true
    } catch (problem) { setError(displayError(problem)); return false }
    finally { setBusy(false); input.current?.focus() }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!assistant || capturing || busy || assistant.active || assistant.storageError || (!draft.trim() && (!capture || highlightMode))) return
    if (!assistant.config.configured) { setView('settings'); return }
    await deliver(draft.trim() || 'Explain what is happening on this screen. Be specific about visible content and uncertainty.', 'chat', capture, highlightMode ? 'highlight' : 'explain')
  }

  function queueSpeech(taskId: string) {
    speakTasks.current.add(taskId)
    // Forget requests whose replies never showed up (e.g. the user switched conversations).
    while (speakTasks.current.size > 20) speakTasks.current.delete(speakTasks.current.values().next().value!)
  }

  function newConversation() {
    speechPlayer.stop()
    setCapture(null); void bridge.discardScreen(); setSelected(null); setDetail(null); setDraft(''); setError(''); setVoiceNotice(''); setView('chat')
  }

  /** Puts spoken words in the message box (after any typed text) instead of sending them. */
  function holdForReview(text: string, notice: string) {
    setDraft((current) => current.trim() ? current.trimEnd() + ' ' + text : text)
    setVoiceNotice(notice)
    setView('chat')
    input.current?.focus()
  }

  /** Uses the screenshot already waiting in the composer, or takes a fresh one, then sends. */
  async function captureAndDeliver(text: string, mode: 'explain' | 'highlight') {
    let shot = capture
    if (!shot) {
      setCapturing(true); setError('')
      try { shot = unwrap(await bridge.captureScreen()) }
      catch (problem) { setError(displayError(problem)); return }
      finally { setCapturing(false) }
    }
    await deliver(text, 'voice', shot, mode)
  }

  /** A finished voice recording: handle a local shortcut, or send it like a typed message. */
  async function handleTranscript(record: TranscriptRecord) {
    const text = record.text.trim()
    if (!text || !assistant) return
    const intent = matchVoiceIntent(text)
    if (intent.kind === 'stop') {
      speechPlayer.stop()
      if (assistant.active) await stop()
      else if (capture) { setCapture(null); void bridge.discardScreen() }
      return
    }
    if (intent.kind === 'new_conversation') { newConversation(); return }
    if (!assistant.config.configured) { setView('settings'); return }
    if (assistant.storageError) return
    if (assistant.active || busy || capturing) {
      holdForReview(text, 'I’m still working on your last request, so I didn’t send that yet. Your words are in the message box: press Send when I’m done, or say “stop”.')
      return
    }
    if (intent.kind === 'chat' && needsConfirmation(record)) {
      holdForReview(text, 'Did I hear that right? I put your words in the message box. Fix anything that’s wrong, then press Send.')
      return
    }
    if (intent.kind === 'explain_screen') await captureAndDeliver(text, 'explain')
    else if (intent.kind === 'show_me_where') await captureAndDeliver(text, 'highlight')
    else await deliver(text, 'voice', capture, highlightMode ? 'highlight' : 'explain')
  }

  async function stop() {
    if (!assistant?.active) return
    try { unwrap(await bridge.stopRequest(assistant.active.id)) }
    catch (problem) { setError(displayError(problem)) }
  }

  async function loadHistory() {
    if (!history.next || busy) return
    setBusy(true)
    const version = historyVersion.current
    try {
      const page = unwrap(await bridge.listConversations({ before: history.next }))
      if (version === historyVersion.current) setHistory((current) => appendConversations(current, page))
    } catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }

  async function loadMessages() {
    if (!selected || !detail?.nextBefore || busy) return
    const id = selected
    setBusy(true)
    try {
      const page = unwrap(await bridge.getConversation({ id, before: detail.nextBefore }))
      if (selection.current === id) {
        keepScroll.current = true
        setDetail((current) => current && ({
          ...current, messages: [...new Map([...page.messages, ...current.messages].map((message) => [message.id, message])).values()].sort((a, b) => a.seq - b.seq), nextBefore: page.nextBefore
        }))
      }
    } catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }

  async function loadActivity() {
    if (!selected || !detail?.nextActivityBefore || busy) return
    const id = selected
    setBusy(true)
    try {
      const page = unwrap(await bridge.getConversation({ id, beforeEvent: detail.nextActivityBefore }))
      if (selection.current === id) setDetail((current) => current && ({ ...current,
        activity: [...new Map([...(page.activity ?? []), ...(current.activity ?? [])].map((event) => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq),
        nextActivityBefore: page.nextActivityBefore
      }))
    } catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }

  async function remove(id?: string) {
    historyVersion.current++
    setBusy(true); setError('')
    try {
      if (id) {
        unwrap(await bridge.deleteConversation(id))
        setHistory((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }))
        if (selected === id) {
          setSelected(null); setDetail(null)
        }
      } else {
        unwrap(await bridge.clearHistory())
        setHistory({ items: [], next: null }); setSelected(null); setDetail(null)
      }
      return true
    } catch (problem) { setError(displayError(problem)); return false }
    finally { setBusy(false) }
  }

  const active = assistant?.active
  const ready = assistant?.config.configured && !assistant.storageError
  const activity = active?.stage === 'browser' ? (active.progress ?? 'Starting flight search…') : active?.stage === 'capturing' ? 'Capturing screen…' : 'Thinking…'
  return <main className="chat-shell phase-two">
    <header className="chat-header">
      <div className="brand"><span className="brand-mark">t</span><div><strong>Triage</strong><span><i />{active ? activity : 'On your desktop'}</span></div></div>
      <div className="window-controls">
        <button className="icon-button" aria-label="Triage menu" title="Triage menu" onClick={() => bridge.openMenu()}>···</button>
        <button className="icon-button" aria-label="Hide Triage" title="Hide Triage" onClick={() => bridge.hide()}>−</button>
        <button className="icon-button" aria-label="Close chat" title="Close chat · Esc" onClick={() => bridge.closeChat()}>×</button>
      </div>
    </header>
    <nav className="panel-tabs" aria-label="Triage views">
      {(['chat', 'history', 'settings'] as const).map((tab) => <button key={tab} aria-current={view === tab ? 'page' : undefined}
        onClick={() => { setView(tab); setError('') }}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}
      <button className="new-chat" aria-label="Start a new conversation" title="New conversation" onClick={newConversation}>+</button>
    </nav>
    {active && <div className="active-request" role="status">
      <button className="active-open" onClick={() => openConversation(active.conversationId)}>{activity}<span className="thinking-dots">…</span></button>
      <button className="stop-button" onClick={() => void stop()}>■ Stop</button>
    </div>}
    {assistant?.highlight && <div className="highlight-status" role="status">
      <span>Click the highlighted control to clear the marker</span>
      <button className="text-button" onClick={() => void bridge.dismissHighlight().then(unwrap).catch((problem) => setError(displayError(problem)))}>Dismiss highlight</button>
    </div>}
    {assistant?.storageError && <p className="notice error persistent-error" role="alert">{assistant.storageError}</p>}
    {error && <p className="notice error persistent-error" role="alert">{error}</p>}
    {voiceNotice && !error && <p className="notice warning" role="status">{voiceNotice}</p>}

    <div className="chat-content">
      {!assistant ? <p className="loading-note">Opening saved conversations…</p> :
        view === 'settings' ? <SettingsPanel bridge={bridge} config={assistant.config} active={Boolean(active)} /> :
        view === 'history' ? <HistoryPanel page={history} active={active?.conversationId ?? false} busy={busy}
          open={openConversation} loadMore={() => void loadHistory()} remove={(id) => remove(id)} clear={() => remove()} /> :
        selected && !detail ? <p className="loading-note">Opening conversation…</p> :
        detail?.messages.length ? <section className="message-list" role="log" aria-label="Conversation messages">
          <div className="conversation-title">{detail.conversation.title}</div>
          {detail.nextBefore && <button className="text-button" disabled={busy} onClick={() => void loadMessages()}>Load earlier messages</button>}
          {detail.messages.map((message) => <div className={message.role === 'user' ? 'user-message' : 'assistant-message'} key={message.id}>
            <span className="message-author">{message.role === 'user' ? (message.source === 'voice' ? 'You · voice' : 'You') : 'Triage'}</span>
            <p>{message.content}</p>
            {message.role === 'assistant' && message.content &&
              <button type="button" className="read-aloud" onClick={() => void speechPlayer.speak(prepareSpeech(message.content))}>
                <span aria-hidden="true">🔊</span> Read aloud</button>}
            {message.role === 'user' && ['failed', 'stopped', 'interrupted'].includes(message.status) &&
              <div className={`request-outcome request-outcome--${message.status}`}>
                <span>{message.status}: {message.error ?? 'No reply was saved.'}</span>
                <button className="text-button" disabled={Boolean(active) || busy || capturing} onClick={() => {
                  setDraft(message.content); input.current?.focus()
                }}>Use this message again</button>
              </div>}
          </div>)}
          {Boolean(detail.activity?.length) &&
            <details className="activity-timeline" open={active?.stage === 'browser'}>
              <summary>Saved action timeline</summary>
              {detail.nextActivityBefore && <button className="text-button" disabled={busy} onClick={() => void loadActivity()}>Load earlier activity</button>}
              <ol>{detail.activity!.map((event) => <li key={event.seq} className={event.type === 'action_unknown' ? 'notice error' : ''}>
                <time dateTime={new Date(event.createdAt).toISOString()}>{new Date(event.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</time>
                <span>{event.detail}</span>
              </li>)}</ol>
            </details>}
        </section> :
        <div className="welcome">
          <div className="welcome-character"><Character /></div>
          <span className="eyebrow">A LITTLE COMPANY FOR YOUR COMPUTER</span>
          <h1>Hello, I'm Triage<span>.</span></h1>
          <p>Ask a question, or ask me to search Alaska Airlines flights.</p>
          {!ready ? <button className="primary-button welcome-connect" onClick={() => setView('settings')}>Connect your AI key</button> :
            <div className="welcome-note"><span className="note-symbol">↗</span><div><strong>Pick up where you left off</strong><p>Your conversations are saved here.<br />Find them any time in History.</p></div></div>}
        </div>}
      {view === 'chat' && <div ref={bottom} />}
    </div>
    {view === 'chat' && <footer className="chat-footer">
      <VoiceButton bridge={bridge} onTranscript={(record) => void handleTranscript(record)} />
      <div className="screen-controls">
        <button className="text-button" disabled={capturing || busy || Boolean(active)} onClick={() => void captureScreen()}>{capturing ? 'Capturing screen…' : 'Capture screen'}</button>
        <button className="text-button" disabled={Boolean(active) || busy} onClick={() => {
          void bridge.closeBrowser().then(unwrap).catch((problem) => setError(displayError(problem)))
        }}>Close task browser</button>
      </div>
      {capture && <div className="screen-preview">
        <img src={capture.dataUrl} alt="Current display screenshot preview" />
        <div><strong>{capture.metadata.displayName}</strong><p>Sent to your AI provider only when you submit. Not saved; expires in one minute.</p>
          <label className="checkbox-label"><input type="checkbox" checked={highlightMode} onChange={(event) => setHighlightMode(event.target.checked)} />Show me where to click</label>
          {highlightMode && <p>Describe the control below. The marker stays until you click the control or dismiss it. If the screen moves, dismiss and capture again.</p>}
          <button className="text-button" onClick={() => { setCapture(null); void bridge.discardScreen() }}>Discard screenshot</button></div>
      </div>}
      <div className="preview-label"><span />{active ? activity : ready ? `Connected · ${assistant?.config.model}` : 'Connect a key to start'}
        <span className="preview-description">Saved on this Mac</span></div>
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor="message">Message Triage</label>
        <textarea ref={input} id="message" value={draft} maxLength={4000} rows={2}
          placeholder={capture && highlightMode ? 'Which control should I find?' : 'Ask Triage anything…'} disabled={Boolean(active) || busy}
          onChange={(event) => { setDraft(event.target.value); if (!event.target.value.trim()) setVoiceNotice('') }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.currentTarget.form?.requestSubmit()
            }
          }} />
        <button className={capture ? 'send-button screen-send' : 'send-button'} type="submit" disabled={(!draft.trim() && (!capture || highlightMode)) || Boolean(active) || busy || capturing || Boolean(assistant?.storageError)}
          aria-label={ready ? (capture ? (highlightMode ? 'Show me where' : 'Explain screen') : 'Send message') : 'Open key settings'} title="Send · Enter">{capture ? (ready ? (highlightMode ? 'Show me where' : 'Explain screen') : 'Connect key') : '↑'}</button>
      </form>
      <div className="footer-meta"><span>Stop task: ⌘⇧Esc · local history</span>
        {state.shortcutAvailable ? <span className="shortcut"><kbd>⌘</kbd><kbd>⇧</kbd><kbd>space</kbd> to open</span> : <span>Restore from the menu bar</span>}
      </div>
    </footer>}
  </main>
}
