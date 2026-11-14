import { RiskTier, type DistilledPage, type PresentationArm, type SimplifiedView } from '../../shared/simplifier-contracts.ts'

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const TIER_NOTE: Record<RiskTier, string> = {
  [RiskTier.Read]: '',
  [RiskTier.Navigate]: '',
  [RiskTier.EnterData]: 'I will read back what you type',
  [RiskTier.Commit]: 'I will ask before doing this',
  [RiskTier.MoneyOrCredentials]: 'Money or password: I will check with you first'
}

// ---------------------------------------------------------------------------
// "Simplify this page" (the person's own browser or app). The simplified
// window has JavaScript off, so a press travels as a navigation to one of
// these URLs, which the window intercepts and never loads. Pressing an action
// only points at the real control; nothing here can click it.
// ---------------------------------------------------------------------------

export const ACTION_PROTOCOL = 'triage-action:'
export const PRESS_HINT = 'This is the button to press.'
export const pressUrl = (token: string, elementId: string) => `triage-action://press/${token}/${elementId}`
export const showOriginalUrl = (token: string) => `triage-action://original/${token}`

const SCREEN_TIER_NOTE: Record<RiskTier, string> = {
  [RiskTier.Read]: '', [RiskTier.Navigate]: '', [RiskTier.EnterData]: '',
  [RiskTier.Commit]: 'Sends or changes something',
  [RiskTier.MoneyOrCredentials]: 'Money or password'
}
/** Shown once a tier 3-4 action has been pressed and its control is highlighted. */
export const PRESS_WARNING: Partial<Record<RiskTier, string>> = {
  [RiskTier.Commit]: 'Be careful: pressing it sends or changes something. Triage will not press it for you.',
  [RiskTier.MoneyOrCredentials]: 'Be careful: this involves money or a password. Only press it if you are sure. Triage will not press it for you.'
}

export interface ScreenRender {
  /** Ties presses to this exact view, so a stale window cannot act on a newer page. */
  token: string
  /** True when the snapshot had no web area: a native app rather than a browser page. */
  fromScreen: boolean
  /** The action the person pressed, and whether its control could be highlighted. */
  pressed?: { elementId: string; found: boolean; message: string }
}

export interface RenderMeta {
  /** Present for views built from the screen; absent for pages opened in Triage's own browser. */
  screen?: ScreenRender
  pageType: string
  policyMode: string
  hiddenRemoved: number
  originalElements: number
  originalUrl?: string
}

/** Only http(s) links from the original page become clickable; everything else renders as a plain button. */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch { return undefined }
}

/**
 * The universal layout from the design doc: big title, one-sentence purpose,
 * a few large buttons, "Help me" always in the same corner. Font size, number
 * of buttons and narration come from the presentation arm the policy chose.
 * All page-derived text is HTML-escaped.
 */
export function renderSimplifiedView(view: SimplifiedView, arm: PresentationArm, page: DistilledPage, meta: RenderMeta): string {
  const base = Math.round(18 * arm.fontScale)
  const byId = new Map(page.elements.map((el) => [el.id, el]))
  const screen = meta.screen
  const actions = screen ? view.actions.map((action) => {
    const pressed = screen.pressed?.elementId === action.elementId ? screen.pressed : undefined
    const note = SCREEN_TIER_NOTE[action.tier]
    const warning = PRESS_WARNING[action.tier]
    const status = !pressed ? (note ? `<span class="tier t${action.tier}">${escape(note)}</span>` : '')
      : pressed.found ? `<span class="where">${escape(PRESS_HINT)} ${escape(pressed.message)}</span>${warning ? `<span class="warn">${escape(warning)}</span>` : ''}`
      : `<span class="warn">${escape(pressed.message)}</span>`
    return `<a class="action${pressed ? ' pressed' : ''}" href="${escape(pressUrl(screen.token, action.elementId))}"><span class="label">${escape(action.label)}</span>${action.hint ? `<span class="hint">${escape(action.hint)}</span>` : ''}${status}</a>`
  }).join('\n') : view.actions.map((action) => {
    const href = safeHref(byId.get(action.elementId)?.href)
    const note = TIER_NOTE[action.tier]
    const inner = `<span class="label">${escape(action.label)}</span>${action.hint ? `<span class="hint">${escape(action.hint)}</span>` : ''}${note ? `<span class="tier t${action.tier}">${escape(note)}</span>` : ''}`
    return href ? `<a class="action" href="${escape(href)}">${inner}</a>` : `<button class="action" type="button">${inner}</button>`
  }).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Simplified: ${escape(view.title)}</title>
<style>
  :root { --bg: #fbf8f2; --ink: #1d1b16; --muted: #5d574b; --accent: #1f5f8b; --card: #ffffff; --line: #e4ddcf; --warn: #8a3b12; --warnbg: #fff1e6; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: ${base}px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }
  .page { max-width: 860px; margin: 0 auto; padding: 32px 24px 120px; }
  .badge { display: inline-block; font-size: 14px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; margin-bottom: 16px; }
  h1 { font-size: 1.6em; line-height: 1.2; margin: 0 0 12px; }
  .purpose { font-size: 1.1em; color: var(--muted); margin: 0 0 28px; }
  .summary { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 20px 24px; margin-bottom: 28px; }
  .summary li { margin: 0 0 12px; }
  .summary li:last-child { margin-bottom: 0; }
  .concerns { background: var(--warnbg); color: var(--warn); border-radius: 16px; padding: 16px 24px; margin-bottom: 28px; }
  .narration { border-left: 6px solid var(--accent); padding: 8px 20px; margin-bottom: 28px; font-style: italic; }
  .actions { display: grid; gap: 16px; }
  .action { display: flex; flex-direction: column; gap: 4px; text-align: left; width: 100%; background: var(--accent); color: #fff; border: 0; border-radius: 16px; padding: 20px 24px; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .action:focus-visible { outline: 4px solid #f2b705; outline-offset: 3px; }
  .hint { font-weight: 400; font-size: 0.8em; opacity: 0.9; }
  .action.pressed { outline: 5px solid #e76b35; outline-offset: 3px; }
  .where { font-weight: 700; font-size: 0.85em; background: #fff; color: var(--ink); border-radius: 10px; padding: 6px 12px; align-self: flex-start; }
  .warn { font-weight: 700; font-size: 0.8em; background: var(--warnbg); color: var(--warn); border-radius: 10px; padding: 6px 12px; align-self: flex-start; }
  .tier { font-weight: 600; font-size: 0.7em; background: #ffffff26; border-radius: 999px; padding: 2px 10px; align-self: flex-start; }
  .help { position: fixed; right: 24px; bottom: 24px; background: #b3261e; color: #fff; border: 0; border-radius: 999px; padding: 16px 28px; font: inherit; font-weight: 700; }
  .meta { margin-top: 40px; font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 12px; }
  .meta a { color: var(--accent); }
</style></head>
<body><div class="page">
  <span class="badge">${screen?.fromScreen ? 'Simplified from screen' : 'Simplified view'}</span>
  <h1>${escape(view.title)}</h1>
  <p class="purpose">${escape(view.purpose)}</p>
  ${view.summary.length ? `<ul class="summary">${view.summary.map((point) => `<li>${escape(point)}</li>`).join('')}</ul>` : ''}
  ${view.concerns.length ? `<div class="concerns"><strong>Be careful:</strong><ul>${view.concerns.map((c) => `<li>${escape(c)}</li>`).join('')}</ul></div>` : ''}
  ${view.narration ? `<div class="narration">${escape(view.narration)}</div>` : ''}
  <div class="actions">${actions}</div>
  <div class="meta">
    Layout ${escape(arm.id)}: ${arm.fontScale}× text, up to ${arm.maxActions} buttons, plain language ${arm.plainLanguage ? 'on' : 'off'}, voice ${arm.voiceNarration ? 'on' : 'off'} ·
    chosen by policy (${escape(meta.policyMode)}) · page type: ${escape(meta.pageType)} · written by: ${view.source === 'llm' ? 'Claude' : 'rules (no AI)'} ·
    ${meta.originalElements} original elements → ${view.actions.length} buttons · ${meta.hiddenRemoved} hidden elements removed
    ${meta.originalUrl ? ` · <a href="${escape(meta.originalUrl)}">Show original page</a>` : ''}
    ${screen ? ` · Press a button and Triage points to it on your screen. It never presses anything for you. · <a href="${escape(showOriginalUrl(screen.token))}">Show original page</a>` : ''}
  </div>
</div>
<button class="help" type="button">Help me</button>
</body></html>`
}
