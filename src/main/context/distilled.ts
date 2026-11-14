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

function containerRegion(el: ContextElement): PageRegion | null {
  if (DIALOG_ROLES.has(el.role)) return 'dialog'
  if (el.subrole && Object.hasOwn(LANDMARKS, el.subrole)) return LANDMARKS[el.subrole]
  return Object.hasOwn(LANDMARKS, el.role) ? LANDMARKS[el.role] : null
}

interface Scope {
  depth: number
  web: boolean
  dialog: boolean
  landmark: PageRegion | null
  /** Depth of the enclosing navigation landmark, or -1. */
  navDepth: number
}

export function toDistilledPage(snapshot: ContextSnapshot): DistilledPage {
  const windowFrame = snapshot.window.frame
  const windowArea = windowFrame.width * windowFrame.height
  const elements: PageElement[] = []
  const prose: string[] = []
  let interactive = 0
  let maxNavDepth = 0
  // `depth` counts ancestors that are in the list, and the list is in document
  // order, so a stack trimmed to shallower entries is exactly the ancestor chain.
  const scopes: Scope[] = []

  for (const el of snapshot.elements) {
    while (scopes.length && scopes[scopes.length - 1].depth >= el.depth) scopes.pop()
    const parent = scopes[scopes.length - 1]
    const own = containerRegion(el)
    const scope: Scope = {
      depth: el.depth,
      web: Boolean(parent?.web) || el.role === 'AXWebArea',
      dialog: Boolean(parent?.dialog) || own === 'dialog',
      landmark: own && own !== 'dialog' ? own : parent?.landmark ?? null,
      navDepth: own === 'nav' ? el.depth : own && own !== 'dialog' ? -1 : parent?.navDepth ?? -1
    }
    scopes.push(scope)

    // A secure field never has a value (the schema rejects one); the extra check keeps that true here too.
    if (el.role === 'AXStaticText' && !el.secure && el.value) prose.push(el.value)
    if (!el.kind || el.kind === 'text') continue

    const level = el.kind === 'heading' && el.value && /^[1-6]$/.test(el.value) ? Number(el.value) : undefined
    const label = el.label || (el.kind === 'heading' && !el.secure && level === undefined ? el.value ?? '' : '')
    if (!label && el.kind !== 'input' && el.kind !== 'textarea' && el.kind !== 'select') continue
    if (el.kind !== 'heading') interactive++
    const region: PageRegion = scope.dialog ? 'dialog' : scope.landmark ?? (scope.web ? 'main' : 'other')
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
