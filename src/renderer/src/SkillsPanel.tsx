import { useEffect, useState } from 'react'
import type { SkillsBridge, SkillStanding, SkillSummary, SkillsView } from '../../shared/skill-contracts'
import { displayError, unwrap } from './assistant-ui'

const GROUPS: Array<{ standing: SkillStanding; title: string; empty: string }> = [
  { standing: 'known', title: 'You know how to', empty: 'Nothing here yet. It fills in as you use Triage.' },
  { standing: 'learning', title: 'You are getting the hang of', empty: '' },
  { standing: 'new', title: 'Triage will explain these step by step', empty: '' }
]
const sentence = (name: string) => name[0].toUpperCase() + name.slice(1)

/** "What I've learned": plain groups, no scores. A caregiver can mark a skill for extra practice. */
export function SkillsPanel({ bridge, revision }: { bridge: SkillsBridge; revision: number }) {
  const [view, setView] = useState<SkillsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    bridge.getSkills().then((result) => { if (mounted) setView(unwrap(result)) }).catch((problem) => { if (mounted) setError(displayError(problem)) })
    return () => { mounted = false }
  }, [bridge, revision])
  async function practise(skill: SkillSummary, practice: boolean) {
    setBusy(true); setError('')
    try { setView(unwrap(await bridge.setSkillPractice({ id: skill.id, practice }))) }
    catch (problem) { setError(displayError(problem)) }
    finally { setBusy(false) }
  }
  return <section className="skills-view" aria-label="What I’ve learned">
    <div className="view-heading"><div><span className="eyebrow">SAVED ON THIS MAC</span><h2>What I’ve learned</h2></div></div>
    <p className="section-description">Triage notices what you already do comfortably and skips those steps when it explains things. Tick “Practice this” to have Triage walk through a skill every time.</p>
    {view && GROUPS.map((group) => {
      const items = view.skills.filter((skill) => skill.standing === group.standing)
      if (!items.length && !group.empty) return null
      return <div key={group.standing}>
        <h4>{group.title}</h4>
        {items.length ? <ul>{items.map((skill) => <li key={skill.id}>
          <span>{sentence(skill.name)}</span>
          <label><input type="checkbox" checked={skill.practice} disabled={busy} onChange={(event) => void practise(skill, event.target.checked)} />Practice this</label>
        </li>)}</ul> : <p className="field-hint">{group.empty}</p>}
      </div>
    })}
    {!view && !error && <p className="loading-note">Loading…</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>
}
