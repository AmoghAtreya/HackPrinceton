import { useEffect, useState } from 'react'
import type { AssistantBridge, MemorySnapshot, TaskEntry } from '../../shared/assistant-contracts'
import { displayError, unwrap } from './assistant-ui'

const STATUS: Record<TaskEntry['status'], string> = {
  waiting: 'Waiting for you', submitted: 'Done', cancelled: 'Stopped', blocked: 'Stopped for safety', failed: 'Did not finish'
}
const KIND: Record<string, string> = { preference: 'About you', recipe: 'Saved steps', fact: 'Note' }

/**
 * Saved progress for multi-step tasks (LangGraph threads) and the person's
 * memory, inside the History tab. Memory is shown in full and can be removed
 * item by item: people should always be able to see and edit what Triage keeps.
 */
export function MemoryHistory({ bridge, revision, open }: { bridge: AssistantBridge; revision: number; open: (conversationId: string) => void }) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null)
  const [forgetting, setForgetting] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    bridge.getMemory().then((result) => { if (current) setSnapshot(unwrap(result)) })
      .catch((problem) => { if (current) setError(displayError(problem)) })
    return () => { current = false }
  }, [bridge, revision])

  async function forget(id: string): Promise<void> {
    setForgetting(id); setError('')
    try { setSnapshot(unwrap(await bridge.forgetMemory(id))) }
    catch (problem) { setError(displayError(problem)) }
    finally { setForgetting(null) }
  }

  if (!snapshot) return error ? <p className="notice error" role="alert">{error}</p> : null
  return <>
    <div className="learning-history">
      <div className="view-heading"><div><span className="eyebrow">SAVED PROGRESS</span><h3>Tasks</h3></div></div>
      <p className="section-description">Step-by-step tasks like “refill my blood pressure medicine”. Progress is saved after every step, so you can stop and come back. Ask “Where was I?” any time.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      {!snapshot.tasks.length && <div className="empty-history">No tasks yet.<br />Try “refill my blood pressure medicine” in the chat.</div>}
      <div className="history-list">
        {snapshot.tasks.map((task) => <div className="history-card task-card" key={task.threadId}>
          <div className="learning-body">
            <strong>{task.title}</strong>
            <span className={'task-status task-' + task.status}>{STATUS[task.status]} · {Math.min(task.steps.length, task.stepCount)} of about {task.stepCount} steps</span>
            {task.steps.length > 0 && <ol className="task-steps">{task.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
            {task.question && <span className="task-question">Waiting for: {task.question.split('\n')[0]}</span>}
            <time dateTime={new Date(task.updatedAt).toISOString()}>{new Date(task.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
          </div>
          {task.status === 'waiting' && <button className="secondary-button" onClick={() => open(task.conversationId)}>Continue</button>}
        </div>)}
      </div>
    </div>
    <div className="learning-history">
      <div className="view-heading"><div><span className="eyebrow">ONLY ON THIS MAC</span><h3>What Triage remembers</h3></div></div>
      <p className="section-description">Say “remember that my pharmacy is CareWell on Main Street” to add something. Triage uses these to fill in forms for you, and asks before sending anything.</p>
      {!snapshot.memories.length && <div className="empty-history">Nothing saved yet.</div>}
      <div className="history-list">
        {snapshot.memories.map((item) => <div className="history-card learning-card" key={item.id}>
          <div className="learning-body"><strong>{item.text}</strong><span>{KIND[item.kind] ?? item.kind}</span></div>
          <button className="text-button danger" disabled={forgetting !== null} aria-label={`Forget: ${item.text}`} onClick={() => void forget(item.id)}>Forget</button>
        </div>)}
      </div>
    </div>
  </>
}
