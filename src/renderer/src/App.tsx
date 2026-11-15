import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { DesktopBridge, DesktopState } from '../../shared/contracts'
import { Character } from './Character'
import { AssistantPanel } from './AssistantPanel'
import { HighlightOverlay } from './HighlightOverlay'

const initialState: DesktopState = {
  visible: true, chatOpen: false, mood: 'idle', shortcutAvailable: false, voiceShortcut: null
}

function Companion({ bridge, state }: { bridge: DesktopBridge; state: DesktopState }) {
  const pointerId = useRef<number | null>(null)
  const lastInteractive = useRef<boolean | null>(null)

  useEffect(() => {
    const move = (event: MouseEvent): void => {
      if (pointerId.current !== null) return
      const interactive = Boolean(document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-interactive]'))
      if (lastInteractive.current !== interactive) {
        lastInteractive.current = interactive
        bridge.setPointerInteractive(interactive)
      }
    }
    const leave = (): void => {
      if (pointerId.current === null) {
        lastInteractive.current = false
        bridge.setPointerInteractive(false)
      }
    }
    const cancel = (): void => {
      if (pointerId.current !== null) {
        pointerId.current = null
        bridge.endDrag(false)
      }
      leave()
    }
    window.addEventListener('mousemove', move)
    document.addEventListener('mouseleave', leave)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('mousemove', move)
      document.removeEventListener('mouseleave', leave)
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [bridge])

  function start(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    pointerId.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    bridge.beginDrag({ x: event.screenX, y: event.screenY })
  }

  function finish(event: PointerEvent<HTMLButtonElement>, allowClick: boolean): void {
    if (pointerId.current !== event.pointerId) return
    pointerId.current = null
    bridge.endDrag(allowClick, { x: event.screenX, y: event.screenY })
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // The main process hit-tests after its native window movement completes.
    // Recheck the exact DOM shape on the next move without overriding that result
    // using coordinates from the renderer's previous window position.
    lastInteractive.current = null
  }

  return <main className="companion-stage">
    <button className="companion-button" data-interactive
      aria-label="Open Triage chat. Drag to move. Right-click for controls."
      aria-expanded={state.chatOpen}
      onPointerDown={start}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onLostPointerCapture={(event) => finish(event, false)}
      onContextMenu={(event) => { event.preventDefault(); bridge.openMenu() }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          bridge.toggleChat()
        }
      }}>
      <Character mood={state.mood} />
    </button>
    <span className="companion-label"><i />{state.mood === 'thinking' ? 'Thinking…' : 'Triage'}</span>
  </main>
}

function DesktopApp({ bridge }: { bridge: DesktopBridge }) {
  const [state, setState] = useState(initialState)
  const [error, setError] = useState(false)
  const isCompanion = new URLSearchParams(window.location.search).get('view') === 'companion'

  useEffect(() => {
    let active = true
    let receivedEvent = false
    const unsubscribe = bridge.onState((next) => {
      receivedEvent = true
      if (active) setState(next)
    })
    bridge.getState().then((next) => {
      if (active && !receivedEvent) setState(next)
    }).catch(() => { if (active) setError(true) })
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isCompanion) { void bridge.dismissHighlight(); bridge.closeChat() }
    }
    window.addEventListener('keydown', keydown)
    return () => { active = false; unsubscribe(); window.removeEventListener('keydown', keydown) }
  }, [bridge, isCompanion])

  if (error) return <div className="connection-error" role="alert">Triage couldn't connect to its desktop controls. Quit and restart the app.</div>
  return isCompanion ? <Companion bridge={bridge} state={state} /> : <AssistantPanel bridge={bridge} state={state} />
}

export function App() {
  if (new URLSearchParams(window.location.search).get('view') === 'highlight') return <HighlightOverlay />
  if (!window.triage) return <div className="connection-error">Start Triage with <code>npm run dev</code> to use the desktop companion.</div>
  return <DesktopApp bridge={window.triage} />
}
