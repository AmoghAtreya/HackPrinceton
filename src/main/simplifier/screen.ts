import { randomUUID } from 'node:crypto'
import type { ContextSnapshot } from '../../shared/context-contracts.ts'
import type { ElementAnchor, FrameReading, HighlightState, Rectangle } from '../../shared/highlight-contracts.ts'
import type { DistilledPage } from '../../shared/simplifier-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'
import { toDistilledPage } from '../context/distilled.ts'
import type { HighlightPlan } from '../screen/highlight.ts'
import type { SimplificationEngine, SimplifyResult } from './engine.ts'
import { ACTION_PROTOCOL, renderSimplifiedView } from './render.ts'

// "Simplify this page": simplifies whatever is frontmost in the person's own
// browser (or any app), read through the accessibility snapshot instead of
// Playwright. The rule that presentation arms never trigger clicks holds
// here by construction: the only things this class can do to the real page are
// read it and draw a highlight over it. Its ports have no input capability.

export interface ScreenPresenter {
  show(html: string, title: string, focus?: boolean): void
  /** Move out of the way of a highlighted control (desktop points). */
  avoid?(target: Rectangle): void
  close?(): void
}
/** The parts of HighlightController this flow uses. */
export interface ScreenHighlights {
  planElement(anchor: ElementAnchor, displayId: string, taskId: string): HighlightPlan
  present(plan: HighlightPlan): boolean
  clear(): void
  onClicked(listener: (state: HighlightState) => void): () => void
  onLost(listener: (state: HighlightState) => void): () => void
}
/** Implicit outcome signals for one simplified page; the thumbs rating is added when the person rates it. */
export interface ObservedSignals {
  /** The person clicked the highlighted control themselves. */
  taskCompleted: boolean
  durationMs: number
  /** Times the person returned to an earlier URL of the episode after this page was shown. */
  backtracks: number
  /** They pressed "Show original page", which closes the simplified view. */
  showedOriginal: boolean
  /** Times the same URL was simplified again straight afterwards. */
  repeatRequests: number
}

interface Session {
  decisionId: string
  snapshot: ContextSnapshot
  page: DistilledPage
  result: SimplifyResult
  fromScreen: boolean
  shownAt: number
  closedAt?: number
  clicked: boolean
  showedOriginal: boolean
  backtracks: number
  repeatRequests: number
  highlightId?: string
  pressed?: { elementId: string; found: boolean; message: string }
}
interface Episode { id: string; key: string; urls: string[]; lastAt: number; lastDecisionId?: string }

const EPISODE_GAP_MS = 30 * 60 * 1000
const SESSION_LIMIT = 50
const FOUND = 'Look for the orange box on your screen.'
const NOT_FOUND = 'I can’t find that on the screen any more. Bring the page back to the front, or simplify it again.'
const COVERED = 'Triage is covering that button. Move Triage aside and press this again.'
const MOVED = 'The button moved off screen. Press this again when you can see the page.'

/** Pages on one site (or windows of one app) belong to one episode. */
function episodeKey(snapshot: ContextSnapshot): string {
  if (snapshot.url) {
    try { const url = new URL(snapshot.url); return url.protocol + '//' + url.host } catch { /* Fall through. */ }
  }
  return 'app:' + snapshot.app.bundleId
}
function pageUrl(snapshot: ContextSnapshot): string | undefined {
  if (!snapshot.url) return undefined
  try { const url = new URL(snapshot.url); url.hash = ''; return url.href } catch { return snapshot.url }
}

export class ScreenSimplifier {
  private readonly contexts: { capture(): Promise<ContextSnapshot> }
  private readonly engine: Pick<SimplificationEngine, 'simplify'>
  private readonly presenter: ScreenPresenter
  private readonly highlights: ScreenHighlights
  private readonly probe: (pid: number, path: number[]) => Promise<FrameReading>
  private readonly voiceEnabled: () => boolean
  private readonly now: () => number
  private readonly sessions = new Map<string, Session>()
  private current?: Session
  private episode?: Episode
  private presses = 0
  private readonly off: Array<() => void>

  constructor(options: {
    contexts: { capture(): Promise<ContextSnapshot> }
    engine: Pick<SimplificationEngine, 'simplify'>
    presenter: ScreenPresenter
    highlights: ScreenHighlights
    /** Where an element is right now (the native frameOf). Read-only. */
    probe: (pid: number, path: number[]) => Promise<FrameReading>
    voiceEnabled?: () => boolean
    now?: () => number
  }) {
    this.contexts = options.contexts
    this.engine = options.engine
    this.presenter = options.presenter
    this.highlights = options.highlights
    this.probe = options.probe
    this.voiceEnabled = options.voiceEnabled ?? (() => false)
    this.now = options.now ?? Date.now
    this.off = [
      this.highlights.onClicked((state) => {
        const session = this.owner(state)
        if (session) { session.clicked = true; session.highlightId = undefined }
      }),
      this.highlights.onLost((state) => {
        const session = this.owner(state)
        if (!session) return
        session.highlightId = undefined
        if (session.pressed) session.pressed = { ...session.pressed, found: false, message: MOVED }
        if (session === this.current && !session.closedAt) this.render(session, false)
      })
    ]
  }

  private owner(state: HighlightState): Session | undefined {
    for (const session of this.sessions.values()) if (session.highlightId === state.id) return session
    return undefined
  }

  async simplify(userId: string, credentials: { key: string; model: string } | undefined, signal: AbortSignal): Promise<SimplifyResult & { fromScreen: boolean }> {
    const snapshot = await this.contexts.capture()
    if (signal.aborted) throw new AppProblem('stopped', 'Simplification stopped.')
    if (!snapshot.elements.length) throw new AppProblem('nothing_to_simplify', 'I couldn’t read the page in front. Click on the page you want simplified, then ask again.')
    // Just the page: the browser's own toolbar is not part of what the person asked to simplify.
    const page = toDistilledPage(snapshot, { webOnly: true })
    const fromScreen = !snapshot.elements.some((element) => element.role === 'AXWebArea')
    const now = this.now()
    const key = episodeKey(snapshot)
    const url = pageUrl(snapshot)
    if (!this.episode || this.episode.key !== key || now - this.episode.lastAt > EPISODE_GAP_MS) this.episode = { id: randomUUID(), key, urls: [], lastAt: now }
    const episode = this.episode

    const result = await this.engine.simplify({ page, userId, voiceEnabled: this.voiceEnabled(), episodeId: episode.id, credentials, signal })

    // What the person did since the previous page of this episode says something about that page's view.
    const previous = episode.lastDecisionId ? this.sessions.get(episode.lastDecisionId) : undefined
    if (url) {
      if (episode.urls.at(-1) === url) { if (previous) previous.repeatRequests++ }
      else {
        if (episode.urls.includes(url) && previous) previous.backtracks++
        episode.urls.push(url)
      }
    }
    episode.lastAt = now
    episode.lastDecisionId = result.decisionId

    this.highlights.clear()
    if (this.current && !this.current.closedAt) this.current.closedAt = now
    const session: Session = {
      decisionId: result.decisionId, snapshot, page, result, fromScreen, shownAt: now,
      clicked: false, showedOriginal: false, backtracks: 0, repeatRequests: 0
    }
    this.sessions.set(session.decisionId, session)
    while (this.sessions.size > SESSION_LIMIT) this.sessions.delete(this.sessions.keys().next().value!)
    this.current = session
    this.render(session, true)
    return { ...result, fromScreen }
  }

  private render(session: Session, focus: boolean): void {
    const { result, page } = session
    this.presenter.show(renderSimplifiedView(result.view, result.arm, page, {
      pageType: result.pageType, policyMode: result.mode, hiddenRemoved: page.stats.hiddenRemoved,
      originalElements: page.stats.interactiveElements,
      screen: { token: session.decisionId, fromScreen: session.fromScreen, ...(session.pressed ? { pressed: session.pressed } : {}) }
    }), result.view.title, focus)
  }

  /** A `triage-action:` link from the simplified window. Anything unrecognised is ignored. */
  handle(link: string): void {
    let url: URL
    try { url = new URL(link) } catch { return }
    if (url.protocol !== ACTION_PROTOCOL) return
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.hostname === 'press' && parts.length === 2) void this.press(parts[0], parts[1])
    else if (url.hostname === 'original' && parts.length === 1) this.showOriginal(parts[0])
  }

  /**
   * The person pressed an action in the simplified view. This points at the
   * real control and explains it; it never activates the control.
   */
  async press(token: string, elementId: string): Promise<void> {
    const session = this.current
    if (!session || session.decisionId !== token || session.closedAt) return
    // Only actions this view actually offered, resolved in the snapshot the view was built from.
    const action = session.result.view.actions.find((candidate) => candidate.elementId === elementId)
    const element = session.snapshot.elements.find((candidate) => candidate.id === elementId)
    if (!action || !element) return
    const press = ++this.presses
    this.highlights.clear()
    session.highlightId = undefined
    let reading: FrameReading
    try { reading = await this.probe(session.snapshot.app.pid, element.path) }
    catch { reading = { frame: null, frontmost: true } }
    if (press !== this.presses || this.current !== session || session.closedAt) return

    let found = false
    let message = NOT_FOUND
    // The snapshot may be minutes old: trust only an element that is still there, with the same role, right now.
    if (reading.frontmost && reading.frame && reading.role === element.role) {
      try {
        this.presenter.avoid?.(reading.frame)
        const plan = this.highlights.planElement(
          { frame: reading.frame, pid: session.snapshot.app.pid, path: element.path, role: element.role },
          session.snapshot.displayId, session.decisionId)
        if (this.highlights.present(plan)) { found = true; message = FOUND; session.highlightId = plan.state.id }
      } catch (error) {
        if (!(error instanceof AppProblem)) throw error
        if (error.code === 'highlight_obscured') message = COVERED
      }
    }
    session.pressed = { elementId, found, message }
    this.render(session, false)
  }

  /** "Show original page": closes the simplified view so the real page is in front again. */
  showOriginal(token: string): void {
    const session = this.current
    if (!session || session.decisionId !== token || session.closedAt) return
    session.showedOriginal = true
    if (session.highlightId) { this.highlights.clear(); session.highlightId = undefined }
    session.closedAt = this.now()
    this.presenter.close?.()
  }

  /** The simplified window was closed. A highlight stays up so the person can still press the real button. */
  viewClosed(): void {
    if (this.current && !this.current.closedAt) this.current.closedAt = this.now()
  }

  /** What was observed for a simplified page, or undefined if this flow did not produce it. */
  signals(decisionId: string): ObservedSignals | undefined {
    const session = this.sessions.get(decisionId)
    if (!session) return undefined
    const duration = (session.closedAt ?? this.now()) - session.shownAt
    return {
      taskCompleted: session.clicked, durationMs: Math.max(0, Math.min(duration, 24 * 3600 * 1000)),
      backtracks: Math.min(session.backtracks, 1000), showedOriginal: session.showedOriginal,
      repeatRequests: Math.min(session.repeatRequests, 1000)
    }
  }

  /** Called once a page's outcome has been reported; rewards are write-once. */
  forget(decisionId: string): void {
    const session = this.sessions.get(decisionId)
    if (!session) return
    // An open view keeps working after it was rated; only its signals are spent.
    if (this.current !== session || session.closedAt) this.sessions.delete(decisionId)
  }

  dispose(): void {
    for (const off of this.off) off()
    this.sessions.clear()
    this.current = undefined
  }
}

export function describeScreenResult(result: SimplifyResult & { fromScreen: boolean }): string {
  const view = result.view
  const lines = [
    `Simplified${result.fromScreen ? ' from screen' : ''}: ${view.title}`,
    view.purpose,
    '',
    ...view.actions.map((action) => `• ${action.label}`)
  ]
  if (view.concerns.length) lines.push('', 'Be careful: ' + view.concerns.join(' '))
  lines.push('', 'The simplified page is in its own Triage window. Press a button there and I’ll point to it on your screen. I never press anything for you.')
  return lines.join('\n')
}
