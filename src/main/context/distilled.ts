import type { ContextElement, ContextSnapshot } from '../../shared/context-contracts.ts'
import type { DistilledPage, PageElement, PageRegion } from '../../shared/simplifier-contracts.ts'

// Turns an accessibility snapshot into the DistilledPage the simplifier already
// understands, so classify.ts (classifyPage / rankElements / riskTier) runs
// unchanged on any app, not only on pages Playwright can reach.

const LANDMARKS: Record<string, PageRegion> = {
  AXLandmarkNavigation: 'nav',
  AXLandmarkBanner: 'header',
  AXLandmarkContentInfo: 'footer',
  AXLandmarkComplementary: 'aside',
  AXLandmarkMain: 'main',
  AXApplicationDialog: 'dialog',
  AXApplicationAlertDialog: 'dialog',
  AXDialog: 'dialog',
  AXSystemDialog: 'dialog'
}
const DIALOG_ROLES = new Set(['AXSheet', 'AXPopover'])
// Same topics distill.ts treats as pop-up noise: cookie banners and newsletter prompts are never what the person came for.
const OVERLAY_TOPIC = /cookie|consent|newsletter|subscribe|sign up for/i

function containerRegion(el: ContextElement): PageRegion | null {
  const region = DIALOG_ROLES.has(el.role) ? 'dialog'
    : el.subrole && Object.hasOwn(LANDMARKS, el.subrole) ? LANDMARKS[el.subrole]
    : Object.hasOwn(LANDMARKS, el.role) ? LANDMARKS[el.role] : null
  return region === 'dialog' && OVERLAY_TOPIC.test(el.label) ? 'promo' : region
}
// A block that announces itself as an ad, as in distill.ts. Class names are invisible to accessibility, the label is not.
const PROMO_LABEL = /^\s*(sponsored|advertisement|ad|promoted)\b/i
const isOverlay = (region: PageRegion | null) => region === 'dialog' || region === 'promo'

interface Scope {
  depth: number
  web: boolean
  /** Inside a dialog ('dialog') or a cookie / newsletter pop-up ('promo'). */
  overlay: 'dialog' | 'promo' | null
  landmark: PageRegion | null
  /** Depth of the enclosing navigation landmark, or -1. */
  navDepth: number
}

/**
 * `webOnly` leaves out everything outside the web area when the window has one
 * (the browser's own toolbar and tabs), for callers that want just the page.
 */
export function toDistilledPage(snapshot: ContextSnapshot, options: { webOnly?: boolean } = {}): DistilledPage {
  const windowFrame = snapshot.window.frame
  const windowArea = windowFrame.width * windowFrame.height
  const elements: PageElement[] = []
  const prose: string[] = []
  let interactive = 0
  let maxNavDepth = 0
  // `depth` counts ancestors that are in the list, and the list is in document
  // order, so a stack trimmed to shallower entries is exactly the ancestor chain.
  const scopes: Scope[] = []
  // When the page marks its main content, the rest of the web area (side columns, tickers) is not 'main'.
  const hasMain = snapshot.elements.some((el) => el.subrole === 'AXLandmarkMain')
  const pageOnly = Boolean(options.webOnly) && snapshot.elements.some((el) => el.role === 'AXWebArea')
  // An open ad block: its label was just seen at this depth; short text and one call to action follow.
  let ad: { depth: number; texts: number } | null = null

  for (const el of snapshot.elements) {
    while (scopes.length && scopes[scopes.length - 1].depth >= el.depth) scopes.pop()
    const parent = scopes[scopes.length - 1]
    const own = containerRegion(el)
    const scope: Scope = {
      depth: el.depth,
      web: Boolean(parent?.web) || el.role === 'AXWebArea',
      overlay: parent?.overlay === 'promo' || own === 'promo' ? 'promo' : parent?.overlay ?? (own === 'dialog' ? 'dialog' : null),
      landmark: own && !isOverlay(own) ? own : parent?.landmark ?? null,
      navDepth: own === 'nav' ? el.depth : own && !isOverlay(own) ? -1 : parent?.navDepth ?? -1
    }
    scopes.push(scope)

    if (pageOnly && !scope.web) continue
    let promoted = false
    if (el.role === 'AXStaticText' && el.value && PROMO_LABEL.test(el.value)) { ad = { depth: el.depth, texts: 0 }; continue }
    if (ad) {
      const open: { depth: number; texts: number } = ad
      ad = null
      if (el.depth === open.depth) {
        if (el.role === 'AXStaticText' && (el.value?.length ?? 0) < 80 && open.texts < 2) { ad = { depth: open.depth, texts: open.texts + 1 }; continue }
        promoted = el.kind === 'button' || el.kind === 'link'
      }
    }
    // A secure field never has a value (the schema rejects one); the extra check keeps that true here too.
    if (el.role === 'AXStaticText' && !el.secure && el.value) prose.push(el.value)
    if (!el.kind || el.kind === 'text') continue

    const level = el.kind === 'heading' && el.value && /^[1-6]$/.test(el.value) ? Number(el.value) : undefined
    const label = el.label || (el.kind === 'heading' && !el.secure && level === undefined ? el.value ?? '' : '')
    if (!label && el.kind !== 'input' && el.kind !== 'textarea' && el.kind !== 'select') continue
    if (el.kind !== 'heading') interactive++
    const region: PageRegion = promoted ? 'promo' : scope.overlay ?? scope.landmark ?? (scope.web && !hasMain ? 'main' : 'other')
    if (region === 'nav' && scope.navDepth >= 0) maxNavDepth = Math.max(maxNavDepth, el.depth - scope.navDepth)

    const item: PageElement = {
      id: el.id, kind: el.kind, label: label.slice(0, 300), region,
      area: windowArea > 0 ? Math.min(1, (el.frame.width * el.frame.height) / windowArea) : 0,
      top: windowFrame.height > 0 ? Math.max(0, (el.frame.y - windowFrame.y) / windowFrame.height) : 0
    }
    // classify.ts recognises a password field by inputType alone.
    if (el.secure) item.inputType = 'password'
    else if (el.subrole === 'AXSearchField') item.inputType = 'search'
    if (level !== undefined) item.level = level
    if (el.kind === 'link' && el.url && el.url.length <= 2000) item.href = el.url
    elements.push(item)
  }

  const mainText = prose.join('\n').slice(0, 20000)
  return {
    url: snapshot.url ?? '',
    title: (snapshot.window.title || snapshot.app.name).slice(0, 500),
    lang: '',
    elements,
    mainText,
    stats: {
      totalElements: snapshot.elements.length,
      interactiveElements: interactive,
      maxNavDepth,
      textLength: mainText.length,
      hiddenRemoved: 0
    },
    capturedAt: snapshot.capturedAt
  }
}
