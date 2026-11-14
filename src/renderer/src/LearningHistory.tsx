import { useEffect, useState } from 'react'
import type { AssistantBridge, LearningSummary } from '../../shared/assistant-contracts'
import { displayError, unwrap } from './assistant-ui'

const PAGE_TYPES: Record<string, string> = {
  article: 'Article', form: 'Form', checkout: 'Checkout', login: 'Sign-in page', email: 'Email', other: 'Web page'
}

/**
 * The simplifier's learning record inside the History tab: which layout each
 * simplified page used, and the person's rating that teaches the policy.
 * Refetches whenever the assistant state revision changes (e.g. a new /simplify).
 */
export function LearningHistory({ bridge, revision }: { bridge: AssistantBridge; revision: number }) {
  const [summary, setSummary] = useState<LearningSummary | null>(null)
  const [rating, setRating] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    bridge.getLearning().then((result) => { if (current) setSummary(unwrap(result)) })
      .catch((problem) => { if (current) setError(displayError(problem)) })
    return () => { current = false }
  }, [bridge, revision])

  async function rate(decisionId: string, helpful: boolean): Promise<void> {
    setRating(decisionId); setError('')
    try { setSummary(unwrap(await bridge.rateSimplification({ decisionId, helpful }))) }
    catch (problem) { setError(displayError(problem)) }
    finally { setRating(null) }
  }

  return <div className="learning-history">
    <div className="view-heading"><div><span className="eyebrow">LEARNING FROM YOU</span><h3>Simplified pages</h3></div></div>
    <p className="section-description">Each page you simplify with <code>/simplify</code> tries a layout. Rate it, and Triage learns which layout works best for you.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!summary ? <p className="loading-note">Loading learning history…</p> : <>
      <p className="learning-stats">
        {summary.rated} rated{summary.averageReward !== null && <> · average score {Math.round(summary.averageReward * 100)}%</>}
      </p>
      {summary.locked.length > 0 && <ul className="learning-locked">
        {summary.locked.map((item) => <li key={item.pageType}>Settled on for {PAGE_TYPES[item.pageType] ?? item.pageType}: {item.layout}</li>)}
      </ul>}
      {!summary.entries.length && <div className="empty-history">No simplified pages yet.<br />Try <code>/simplify demo</code> in the chat.</div>}
      <div className="history-list">
        {summary.entries.map((entry) => <div className="history-card learning-card" key={entry.decisionId}>
          <div className="learning-body">
            <strong>{entry.site} · {PAGE_TYPES[entry.pageType] ?? entry.pageType}</strong>
            <span>{entry.layout}</span>
            <span>Written by {entry.source === 'llm' ? 'Claude' : 'rules (no AI)'}</span>
            <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
          </div>
          {entry.reward !== null ? <span className="learning-score">Score {Math.round(entry.reward * 100)}%</span> :
            <div className="learning-rate" role="group" aria-label={`Rate the simplified ${entry.site} page`}>
              <button className="secondary-button" disabled={rating !== null} onClick={() => void rate(entry.decisionId, true)}>Helpful</button>
              <button className="text-button" disabled={rating !== null} onClick={() => void rate(entry.decisionId, false)}>Not helpful</button>
            </div>}
        </div>)}
      </div>
    </>}
  </div>
}
