import { useEffect, useState } from 'react'
import type { HighlightState } from '../../shared/highlight-contracts'

export function HighlightOverlay() {
  const [state, setState] = useState<HighlightState | null>(null)
  const bridge = window.triageOverlay
  useEffect(() => {
    document.documentElement.classList.add('highlight-document')
    if (!bridge) return
    let mounted = true
    let received = false
    const off = bridge.onHighlight((next) => { received = true; if (mounted) setState(next) })
    bridge.getHighlight().then((next) => { if (mounted && !received) setState(next) }).catch(() => {})
    return () => { mounted = false; off(); document.documentElement.classList.remove('highlight-document') }
  }, [bridge])
  useEffect(() => {
    if (!state || !bridge) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => bridge.highlightReady(state.id))
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [state?.id, bridge])
  if (!state || (state.expiresAt !== null && state.expiresAt <= Date.now())) return null
  if (state.warnings) return <div className="highlight-surface" aria-hidden="true">
    {state.warnings.map(({ rectangle, label }, index) => <div key={index}
      className="link-warning" data-warning={label}
      style={{ left: rectangle.x, top: rectangle.y, width: rectangle.width, height: rectangle.height }}>
      <span>{label}</span>
    </div>)}
  </div>
  const viewport = state.overlayBounds ?? state.bounds
  const offsetX = state.bounds.x - viewport.x
  const offsetY = state.bounds.y - viewport.y
  const target = {
    ...state.rectangle,
    x: state.rectangle.x + offsetX, y: state.rectangle.y + offsetY
  }
  const origin = state.arrowOrigin && {
    x: state.arrowOrigin.x - viewport.x, y: state.arrowOrigin.y - viewport.y
  }
  const center = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
  const dx = origin ? origin.x - center.x : 0
  const dy = origin ? origin.y - center.y : 0
  // Stop outside the enlarged outline, leaving the control unobscured.
  const edge = Math.max(Math.abs(dx) / (target.width / 2 + 12), Math.abs(dy) / (target.height / 2 + 12))
  const end = edge > 1 ? { x: center.x + dx / edge, y: center.y + dy / edge } : null
  return <div className="highlight-surface" aria-hidden="true">
    {origin && end && <svg className="highlight-arrow" viewBox={`0 0 ${viewport.width} ${viewport.height}`}>
      <defs>
        <marker id="highlight-arrowhead" viewBox="0 0 12 12" refX="10" refY="6"
          markerWidth="18" markerHeight="18" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 1 1 L 10 6 L 1 11 Z" fill="#e76b35" stroke="#fffaf2" strokeWidth="1.5" strokeLinejoin="round" />
        </marker>
      </defs>
      <line x1={origin.x} y1={origin.y} x2={end.x} y2={end.y} stroke="#fffaf2" strokeWidth="7" strokeLinecap="round" />
      <line x1={origin.x} y1={origin.y} x2={end.x} y2={end.y} stroke="#e76b35" strokeWidth="3.5"
        strokeLinecap="round" markerEnd="url(#highlight-arrowhead)" />
      <circle cx={origin.x} cy={origin.y} r="5" fill="#e76b35" stroke="#fffaf2" strokeWidth="2" />
    </svg>}
    <div className="highlight-target" style={{
      left: target.x, top: target.y,
      width: target.width, height: target.height
    }} />
  </div>
}
