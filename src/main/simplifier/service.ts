import { chromium, type Browser, type Page } from 'playwright'
import { browserMissingMessage, channelLaunchOptions, type BrowserChannel } from '../../shared/browser-config.ts'
import type { SimplifyResult } from './engine.ts'
import type { SimplificationEngine } from './engine.ts'
import { distillPage } from './distill.ts'
import { renderSimplifiedView } from './render.ts'
import { AppProblem } from '../assistant/errors.ts'

/** Where to show the simplified page. Implemented in index.ts with a locked-down BrowserWindow. */
export interface SimplifiedPresenter {
  /** Links clicked in the simplified view are passed to SimplifierService.open, never followed in place. */
  show(html: string, title: string): void
}

export interface SimplifyCommand {
  /** An http(s) URL, or null for the built-in demo page. */
  url: string | null
}

/** Parse "/simplify <url>" or "/simplify demo". Returns null when the text is not a simplify command. */
export function parseSimplifyCommand(text: string): SimplifyCommand | null {
  const match = /^\/simplify(?:\s+(\S+))?\s*$/i.exec(text.trim())
  if (!match) return null
  const target = match[1]
  if (!target || target.toLowerCase() === 'demo') return { url: null }
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(target) ? target : 'https://' + target) }
  catch { throw new AppProblem('invalid_url', 'That does not look like a web address. Try /simplify example.com or /simplify demo.') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppProblem('invalid_url', 'Only http and https pages can be simplified.')
  return { url: url.href }
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

  constructor(options: { engine: SimplificationEngine; presenter: SimplifiedPresenter; channel: BrowserChannel; demoHtml: string }) {
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
    const page = await this.page()
    if (command.url) await page.goto(command.url, { waitUntil: 'load' })
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
    return result
  }

  /** Follow a link from the simplified view in the Chrome window. */
  async open(url: string): Promise<void> {
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
