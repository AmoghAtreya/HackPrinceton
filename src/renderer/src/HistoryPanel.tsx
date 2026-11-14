import { useState } from 'react'
import type { AssistantBridge, ConversationPage } from '../../shared/assistant-contracts'
import type { SkillsBridge } from '../../shared/skill-contracts'
import { SkillsPanel } from './SkillsPanel'
import { LearningHistory } from './LearningHistory'
import { MemoryHistory } from './MemoryHistory'

export function HistoryPanel({ bridge, revision, page, active, busy, open, loadMore, remove, clear }: {
  bridge: AssistantBridge & SkillsBridge; revision: number
  page: ConversationPage; active: boolean | string; busy: boolean
  open: (id: string) => void; loadMore: () => void
  remove: (id: string) => Promise<boolean | void>; clear: () => Promise<boolean | void>
}) {
  const [confirm, setConfirm] = useState<string | null>(null)
  return <section className="history-view">
    <div className="view-heading"><div><span className="eyebrow">SAVED ON THIS MAC</span><h2>Your conversations</h2></div></div>
    <p className="section-description">Revisit a conversation without rerunning its requests.</p>
    {!page.items.length && <div className="empty-history">No conversations yet.<br />Connect your key and start a chat.</div>}
    <div className="history-list">
      {page.items.map((item) => <div className="history-card" key={item.id}>
        <button className="history-open" onClick={() => open(item.id)}>
          <strong>{item.title}</strong>
          <time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
        </button>
        {confirm === item.id ? <div className="delete-confirm">
          <p>Delete this conversation permanently?</p>
          <button className="text-button danger" disabled={busy || active === true || active === item.id} onClick={async () => { if (await remove(item.id) !== false) setConfirm(null) }}>Delete permanently</button>
          <button className="text-button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        </div> : <button className="history-delete" disabled={active === true || active === item.id || busy}
          aria-label={`Delete conversation: ${item.title}`} onClick={() => setConfirm(item.id)}>Delete</button>}
      </div>)}
    </div>
    {page.next && <button className="secondary-button" disabled={busy} onClick={loadMore}>Load older conversations</button>}
    <MemoryHistory bridge={bridge} revision={revision} open={open} />
    <SkillsPanel bridge={bridge} revision={revision} />
    <LearningHistory bridge={bridge} revision={revision} />
    {page.items.length > 0 && <div className="clear-history">
      {confirm === 'all' ? <>
        <p>Delete all saved conversations from this Mac?</p>
        <button className="text-button danger" disabled={Boolean(active) || busy} onClick={async () => { if (await clear() !== false) setConfirm(null) }}>Confirm clear history</button>
        <button className="text-button" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
      </> : <button className="text-button danger" disabled={Boolean(active) || busy} onClick={() => setConfirm('all')}>Clear all history</button>}
      <p className="field-hint">Deletion does not undo requests already sent to your AI provider and is not a guarantee of secure disk erasure.</p>
    </div>}
  </section>
}
