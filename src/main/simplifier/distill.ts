import type { Page } from 'playwright'
import { distilledPageSchema, type DistilledPage } from '../../shared/simplifier-contracts.ts'

/**
 * Runs INSIDE the web page (via Playwright's page.evaluate). It must stay
 * self-contained: no imports, no references to outer variables.
 *
 * Prompt-injection hygiene from the design doc: hidden, off-screen, aria-hidden
 * and zero-size nodes are dropped before anything reaches the LLM, and form
 * VALUES are never read, only their labels.
 */
export function distillDocument(limit: number): unknown {
  const doc = document
  const viewportW = Math.max(window.innerWidth, 1)
  const viewportH = Math.max(window.innerHeight, 1)
  const pageH = Math.max(doc.documentElement.scrollHeight, viewportH)
  const clean = (text: string | null | undefined, max = 300) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  let hiddenRemoved = 0

  const visible = (el: Element): boolean => {
    if (el.closest('[aria-hidden="true"], [hidden], template, noscript')) return false
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    const absTop = rect.top + window.scrollY
    const absLeft = rect.left + window.scrollX
    // Off-screen tricks: pushed far left/up, or clipped to nothing.
    if (absLeft + rect.width < 0 || absTop + rect.height < 0 || absLeft > doc.documentElement.scrollWidth + 50) return false
    if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') return false
    return true
  }

  const regionOf = (el: Element): string => {
    if (el.closest('dialog, [role="dialog"], [role="alertdialog"]')) return 'dialog'
    if (el.closest('main, [role="main"], article')) return 'main'
    if (el.closest('nav, [role="navigation"]')) return 'nav'
    if (el.closest('header, [role="banner"]')) return 'header'
    if (el.closest('footer, [role="contentinfo"]')) return 'footer'
    if (el.closest('aside, [role="complementary"]')) return 'aside'
    return 'other'
  }

  const labelOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria) return clean(aria)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? '').join(' ')
      if (clean(text)) return clean(text)
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const labels = el.labels ? Array.from(el.labels).map((l) => l.textContent ?? '').join(' ') : ''
      if (clean(labels)) return clean(labels)
      if ('placeholder' in el && el.placeholder) return clean(el.placeholder)
      if (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button')) return clean(el.value)
      return clean(el.getAttribute('name') ?? el.getAttribute('title'))
    }
    if (el instanceof HTMLImageElement) return clean(el.alt)
    const text = clean((el as HTMLElement).innerText ?? el.textContent)
    if (text) return text
    const img = el.querySelector('img[alt]')
    return clean(img?.getAttribute('alt') ?? el.getAttribute('title'))
  }

  const kindOf = (el: Element): string | null => {
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role')
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (tag === 'button' || role === 'button') return 'button'
    if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select'
    if (tag === 'textarea') return 'textarea'
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type
      if (type === 'hidden') return null
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return 'button'
      return 'input'
    }
    if (role === 'link') return 'link'
    if (role === 'checkbox' || role === 'switch') return 'checkbox'
    if (role === 'textbox' || role === 'searchbox') return 'input'
    return null
  }

  const depthOf = (el: Element): number => {
    let depth = 0
    for (let node = el.parentElement; node; node = node.parentElement) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'ul' || tag === 'ol' || tag === 'nav' || tag === 'menu') depth++
    }
    return depth
  }

  const selector = 'h1,h2,h3,h4,h5,h6,a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"]'
  const candidates = Array.from(doc.querySelectorAll(selector))
  const elements: Record<string, unknown>[] = []
  let interactive = 0
  let maxNavDepth = 0
  for (const el of candidates) {
    if (!visible(el)) { hiddenRemoved++; continue }
    const kind = kindOf(el)
    if (!kind) continue
    const label = labelOf(el)
    if (!label && kind !== 'input' && kind !== 'textarea' && kind !== 'select') continue
    if (kind !== 'heading') interactive++
    const region = regionOf(el)
    if (region === 'nav') maxNavDepth = Math.max(maxNavDepth, depthOf(el))
    if (elements.length >= limit) continue
    const rect = el.getBoundingClientRect()
    const id = 'e' + elements.length
    // Stamp the live DOM so an executor can find the element again later.
    el.setAttribute('data-triage-id', id)
    const item: Record<string, unknown> = {
      id, kind, label, region,
      area: Math.min(1, (rect.width * rect.height) / (viewportW * viewportH)),
      top: Math.max(0, (rect.top + window.scrollY) / pageH)
    }
    if (kind === 'heading') item.level = Number(el.tagName[1])
    if (el instanceof HTMLInputElement) item.inputType = el.type.slice(0, 40)
    const auto = el.getAttribute('autocomplete')
    if (auto) item.autocomplete = auto.slice(0, 80)
    if (el instanceof HTMLAnchorElement && el.href) item.href = el.href.slice(0, 2000)
    elements.push(item)
  }

  // Main readable text: prefer <main>/<article>, fall back to body. Collect
  // prose blocks one per line, and run each through visible(): innerText alone
  // still includes off-screen "screen reader trap" text, a prompt-injection path.
  const root = doc.querySelector('main, [role="main"], article') ?? doc.body
  const blocks: string[] = []
  let textLength = 0
  for (const block of Array.from(root?.querySelectorAll('p, li, blockquote, dd, td, pre') ?? [])) {
    if (block.closest('nav, header, footer, aside, dialog, [role="dialog"], [role="navigation"]')) continue
    if (block.parentElement?.closest('p, li, blockquote, dd, td, pre')) continue
    if (!visible(block)) { hiddenRemoved++; continue }
    const text = clean((block as HTMLElement).innerText, 4000)
    if (!text) continue
    blocks.push(text)
    textLength += text.length + 1
    if (textLength > 20000) break
  }
  const mainText = (blocks.length ? blocks.join('\n') : clean((root as HTMLElement | null)?.innerText ?? '', 20000)).slice(0, 20000)

  return {
    url: location.href.slice(0, 4000),
    title: clean(doc.title, 500),
    lang: clean(doc.documentElement.lang, 20),
    elements,
    mainText,
    stats: {
      totalElements: doc.getElementsByTagName('*').length,
      interactiveElements: interactive,
      maxNavDepth,
      textLength: clean((doc.body as HTMLElement | null)?.innerText ?? '', 1e7).length,
      hiddenRemoved
    },
    capturedAt: Date.now()
  }
}

/** Distil the current Playwright page and validate the result before trusting it. */
export async function distillPage(page: Page, limit = 150): Promise<DistilledPage> {
  const raw = await page.evaluate(distillDocument, Math.min(Math.max(limit, 1), 400))
  return distilledPageSchema.parse(raw)
}
