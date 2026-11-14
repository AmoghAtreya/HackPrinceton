import { chromium, type Browser, type Page } from 'playwright'
import { browserMissingMessage, channelLaunchOptions, type BrowserChannel } from '../../shared/browser-config.ts'
import type { SimplifyResult } from './engine.ts'
import type { SimplificationEngine } from './engine.ts'
import { distillPage } from './distill.ts'
import { renderSimplifiedView } from './render.ts'
import { AppProblem } from '../assistant/errors.ts'
import type { LearningSummary } from '../../shared/assistant-contracts.ts'
import type { PageType } from '../../shared/simplifier-contracts.ts'
import { armById } from './arms.ts'
import type { DecisionLog } from './decision-log.ts'
import { EXPECTED_MS } from './reward.ts'
import type { ObservedSignals } from './screen.ts'

/** Where to show the simplified page. Implemented in index.ts with a locked-down BrowserWindow. */
export interface SimplifiedPresenter {
  /** Links clicked in the simplified view are passed to SimplifierService.open, never followed in place. */
  show(html: string, title: string): void
}

/**
 * What to simplify:
 * - current: the page open in the person's own browser right now ("/simplify")
 * - url: a typed address ("/simplify example.com")
 * - demo: the built-in example page ("/examplesimplify")
 */
export type SimplifyCommand = { kind: 'current' } | { kind: 'url'; url: string } | { kind: 'demo' }

export const NO_CURRENT_TAB = 'I couldn’t tell which web page you have open. Open the page in Chrome, click on it, then type /simplify again. You can also type /simplify followed by a web address.'

/**
 * Parse "/simplify", "/simplify <url>" or "/examplesimplify".
 * Returns null when the text is not a simplify command.
 */
export function parseSimplifyCommand(text: string): SimplifyCommand | null {
  const trimmed = text.trim()
  if (/^\/examplesimplify\s*$/i.test(trimmed)) return { kind: 'demo' }
  const match = /^\/simplify(?:\s+(\S+))?\s*$/i.exec(trimmed)
  if (!match) return null
  const target = match[1]
  if (!target) return { kind: 'current' }
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(target) ? target : 'https://' + target) }
  catch { throw new AppProblem('invalid_url', 'That does not look like a web address. Type /simplify on its own for the page you have open, /simplify example.com, or /examplesimplify for the example page.') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppProblem('invalid_url', 'Only http and https pages can be simplified.')
  return { kind: 'url', url: url.href }
}

/**
 * Opens a real website in Triage's Chromium. Busy sites (ads, trackers) may
 * never fire "load", so the page is used once its HTML is ready and has had a
 * few seconds to finish drawing. A failure becomes a plain message.
 */
async function loadPage(page: Page, url: string): Promise<void> {
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }) }
  catch { throw new AppProblem('page_load', 'I couldn’t open ' + hostOf(url) + ' in Triage’s browser. Check your internet connection, then try /simplify again.') }
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return 'that page' }
}

/** Implicit signals gathered while a simplified page is on screen. */
interface ViewSession { decisionId: string; shownAt: number; closedAt?: number; linksFollowed: number }

export function describeLayout(armId: string): string {
  try {
    const arm = armById(armId)
    return `${arm.fontScale}× text, up to ${arm.maxActions} buttons${arm.plainLanguage ? ', plain language' : ''}${arm.voiceNarration ? ', read aloud' : ''}`
  } catch { return 'Retired layout ' + armId }
}

/**
 * Opens the original page in Chrome (the "before" view), distils it, runs the
 * simplification engine, and hands the rendered "after" page to the presenter.
 */
export class SimplifierService {
  private browser?: Browser
  private before?: Page
  private readonly engine: SimplificationEngine
  private readonly presenter: SimplifiedPresenter
  private readonly channel: BrowserChannel
  private readonly demoHtml: string
  private readonly log: DecisionLog
  private readonly lockedLayouts: (userId: string) => Partial<Record<PageType, string>>
  private readonly observed: (decisionId: string) => ObservedSignals | undefined
  private readonly reported: (userId: string, pageType: PageType, signals: ObservedSignals) => void
  private readonly now: () => number
  private readonly currentTab: (own?: string) => Promise<string | undefined>
  private readonly sessions = new Map<string, ViewSession>()
  private current?: ViewSession

  constructor(options: {
    engine: SimplificationEngine; presenter: SimplifiedPresenter; channel: BrowserChannel; demoHtml: string
    log: DecisionLog; lockedLayouts?: (userId: string) => Partial<Record<PageType, string>>; now?: () => number
    /** Signals for pages simplified from the screen, which this class did not show itself. */
    observed?: (decisionId: string) => ObservedSignals | undefined
    /** Told what was observed on a page once its outcome is reported, e.g. to update the skill graph. */
    reported?: (userId: string, pageType: PageType, signals: ObservedSignals) => void
    /** The address open in the person's own browser, for a bare "/simplify". */
    /** `own` is the address already open in Triage's browser, which the person is probably not asking about. */
    currentTab?: (own?: string) => Promise<string | undefined>
  }) {
    this.currentTab = options.currentTab ?? (async () => undefined)
    this.reported = options.reported ?? (() => {})
    this.observed = options.observed ?? (() => undefined)
    this.log = options.log
    this.lockedLayouts = options.lockedLayouts ?? (() => ({}))
    this.now = options.now ?? Date.now
    this.engine = options.engine
    this.presenter = options.presenter
    this.channel = options.channel
    this.demoHtml = options.demoHtml
  }

  private async page(): Promise<Page> {
    if (!this.browser?.isConnected()) {
      try {
        this.browser = await chromium.launch({ ...channelLaunchOptions(this.channel), headless: false, args: ['--no-first-run', '--no-default-browser-check'] })
      } catch {
        throw new AppProblem('browser_start', browserMissingMessage(this.channel))
      }
      this.browser.on('disconnected', () => { this.browser = undefined; this.before = undefined })
    }
    if (!this.before || this.before.isClosed()) {
      const context = await this.browser.newContext({ viewport: null })
      this.before = await context.newPage()
      this.before.setDefaultNavigationTimeout(30000)
      this.before.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}) })
    }
    return this.before
  }

  async simplify(command: SimplifyCommand, userId: string, credentials: { key: string; model: string } | undefined, signal: AbortSignal): Promise<SimplifyResult> {
    // Read the address before Triage's Chromium opens, so its window is never mistaken for the person's page.
    const url = command.kind === 'url' ? command.url : command.kind === 'current' ? await this.currentTab(this.ownUrl()) : undefined
    if (command.kind === 'current' && !url) throw new AppProblem('no_current_page', NO_CURRENT_TAB)
    if (signal.aborted) throw new AppProblem('stopped', 'Simplification stopped.')
    const page = await this.page()
    if (url) await loadPage(page, url)
    else await page.setContent(this.demoHtml, { waitUntil: 'load' })
    if (signal.aborted) throw new AppProblem('stopped', 'Simplification stopped.')
    await page.bringToFront().catch(() => {})
    const distilled = await distillPage(page)
    const result = await this.engine.simplify({ page: distilled, userId, voiceEnabled: false, credentials, signal })
    const html = renderSimplifiedView(result.view, result.arm, distilled, {
      pageType: result.pageType, policyMode: result.mode, hiddenRemoved: distilled.stats.hiddenRemoved,
      originalElements: distilled.stats.interactiveElements
    })
    this.presenter.show(html, result.view.title)
    if (this.current && !this.current.closedAt) this.current.closedAt = this.now()
    this.current = { decisionId: result.decisionId, shownAt: this.now(), linksFollowed: 0 }
    this.sessions.set(result.decisionId, this.current)
    return result
  }

  /** What Triage's own browser page shows now, if it is a real site. */
  private ownUrl(): string | undefined {
    if (!this.before || this.before.isClosed()) return undefined
    const url = this.before.url()
    return /^https?:/i.test(url) ? url : undefined
  }

  /** Triage's own Chrome page, shared with task drivers (e.g. the pharmacy refill). */
  browserPage(): Promise<Page> { return this.page() }

  /** Called by the presenter when the simplified window closes. */
  viewClosed(): void {
    if (this.current && !this.current.closedAt) this.current.closedAt = this.now()
  }

  /** Recent simplifications and what the policy has learned, for the History tab. */
  learning(userId: string): LearningSummary {
    const entries = this.log.recent(userId, 20).map((decision) => {
      let site = decision.pageHost
      if (!site) site = 'Demo page'
      return {
        decisionId: decision.id, createdAt: decision.createdAt, site, pageType: decision.pageType,
        layout: describeLayout(decision.armId), source: decision.viewSource, mode: decision.mode, reward: decision.reward
      }
    })
    const locked = Object.entries(this.lockedLayouts(userId)).map(([pageType, armId]) => ({ pageType, layout: describeLayout(armId!) }))
    return { entries, ...this.log.ratingStats(userId), locked }
  }

  /**
   * The person's rating closes the loop: it is combined with the implicit
   * signals seen while the page was on screen into one reward, which trains the
   * policy. Ratings are write-once per simplified page.
   */
  rate(userId: string, decisionId: string, helpful: boolean): LearningSummary {
    const decision = this.log.get(decisionId)
    if (!decision || decision.userId !== userId) throw new AppProblem('not_found', 'That simplified page is no longer in the learning history.')
    if (decision.reward !== null) throw new AppProblem('already_rated', 'This simplified page was already rated.')
    const session = this.sessions.get(decisionId)
    // Without a session (e.g. rated after a restart), assume a typical visit length.
    const durationMs = session ? (session.closedAt ?? this.now()) - session.shownAt : EXPECTED_MS[decision.pageType]
    const observed = this.observed(decisionId)
    // A page simplified from the screen was watched directly: use what happened, plus this rating.
    if (observed) {
      this.engine.reportOutcome(decisionId, { ...observed, thumbsUp: helpful })
      this.reported(userId, decision.pageType, observed)
    }
    else this.engine.reportOutcome(decisionId, {
      // "Helpful" is the closest available proxy for having finished what the person came to do.
      taskCompleted: helpful, durationMs: Math.max(0, Math.min(durationMs, 24 * 3600 * 1000)),
      backtracks: Math.min(session?.linksFollowed ?? 0, 1000), thumbsUp: helpful, showedOriginal: false, repeatRequests: 0
    })
    this.sessions.delete(decisionId)
    if (this.current?.decisionId === decisionId) this.current = undefined
    return this.learning(userId)
  }

  /** Follow a link from the simplified view in the Chrome window. */
  async open(url: string): Promise<void> {
    if (this.current && !this.current.closedAt) this.current.linksFollowed++
    const page = await this.page()
    await page.goto(url, { waitUntil: 'load' }).catch(() => {})
    await page.bringToFront().catch(() => {})
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {})
    this.browser = undefined
  }
}

export function describeResult(result: SimplifyResult): string {
  const view = result.view
  const lines = [
    `Simplified: ${view.title}`,
    view.purpose,
    '',
    `Layout ${result.arm.id} (${result.arm.fontScale}× text, up to ${result.arm.maxActions} buttons${result.arm.plainLanguage ? ', plain language' : ''}) · page type ${result.pageType} · written by ${view.source === 'llm' ? 'Claude' : 'rules (no AI)'}`,
    ...view.actions.map((action) => `• ${action.label}`)
  ]
  if (view.concerns.length) lines.push('', 'Be careful: ' + view.concerns.join(' '))
  lines.push('', 'The original is open in Chrome; the simplified page is in its own Triage window.')
  return lines.join('\n')
}
