import type { ScreenAnalysis, SimplifiedView } from '../../shared/screen-analysis-contracts'

const verdictLabels = { looks_safe: 'No warning signs', be_careful: 'Be careful', likely_scam: 'This looks like a scam' } as const

/**
 * Shows a simplified view (big task buttons) or a safety check result above
 * the composer. Buttons hand their instruction back to the chat panel.
 */
export function ScreenHelpCard({ analysis, disabled, onAction, onClose }: {
  analysis: ScreenAnalysis
  disabled: boolean
  onAction: (action: SimplifiedView['actions'][number]) => void
  onClose: () => void
}) {
  if (analysis.kind === 'simplify') {
    return <section className="screen-help simplified-view" aria-label="Simplified view">
      <div className="screen-help-header"><strong>What you can do here</strong>
        <button type="button" className="text-button" onClick={onClose}>Close</button></div>
      <p className="screen-help-summary">{analysis.view.summary}</p>
      <div className="simplified-actions">
        {analysis.view.actions.map((action, index) => <button key={index} type="button" className="simplified-action" disabled={disabled}
          title={action.instruction} onClick={() => onAction(action)}>
          <span aria-hidden="true">{action.kind === 'show_me_where' ? '👉' : '💬'}</span>{action.label}</button>)}
      </div>
      <p className="field-hint">Press a button and I’ll point to it or explain it. Nothing is clicked for you.</p>
    </section>
  }
  const { check } = analysis
  return <section className={`screen-help safety-check safety-check--${check.verdict}`} aria-label="Safety check" role="status">
    <div className="screen-help-header"><strong>{verdictLabels[check.verdict]}</strong>
      <button type="button" className="text-button" onClick={onClose}>Close</button></div>
    <p className="safety-headline">{check.headline}</p>
    {check.reasons.length > 0 && <ul className="safety-reasons">{check.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    <p className="safety-advice">{check.advice}</p>
    {check.verdict !== 'looks_safe' && <p className="field-hint">When in doubt, don’t click, call, pay or share any codes. Ask someone you trust first.</p>}
  </section>
}
