import type { ContextSnapshot } from '../../shared/context-contracts.ts'
import { toDistilledPage } from '../context/distilled.ts'
import { classifyPage, isMailHost, isSensitive } from '../simplifier/classify.ts'
import { normalizeEmail, normalizeHost } from './normalize.ts'

// What the screen CLAIMS: who a message or page presents itself as, and the
// channel it actually arrived through. Everything here is untrusted input to a
// comparison. It is computed by rules, held in memory, and never written to
// the graph.

export interface ScreenClaim {
  kind: 'email' | 'page'
  /** The names it presents: a sender's display name, or the title and headings of a page. */
  claimed: string[]
  channelType: 'email' | 'website'
  /** The sender's address, or the page's host. */
  channelValue: string
  /** Pressure tactics found in the visible text, as short plain phrases. */
  cues: string[]
}

const MAIL_APPS = new Set(['com.apple.mail', 'com.microsoft.Outlook', 'com.readdle.smartemail-Mac', 'com.google.Chrome.app.gmail', 'org.mozilla.thunderbird'])
const ADDRESS = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/
const NAMED_SENDER = new RegExp('^(?:from:?\\s+)?["“]?([^<>"“”@]{1,80}?)["”]?\\s*<\\s*(' + ADDRESS.source + ')\\s*>', 'i')
const BARE_SENDER = new RegExp('^<?\\s*(' + ADDRESS.source + ')\\s*>?$')
const FROM_MARKER = /^from:?$/i

const CUES: Array<[RegExp, string]> = [
  [/\bgift ?cards?\b/i, 'It asks for gift cards.'],
  [/\b(wire transfer|wire (me|the) money|western union|moneygram|zelle)\b/i, 'It asks you to send money.'],
  [/\b(bitcoin|crypto(currency)?)\b/i, 'It asks for cryptocurrency.'],
  [/\b(urgent(ly)?|right away|immediately|as soon as possible|asap|act now)\b/i, 'It says it is urgent.'],
  [/\b(don'?t|do not) tell\b|\bkeep (this|it) (a )?secret\b|\bbetween us\b/i, 'It asks you to keep it secret.']
]

/** Visible strings in document order: prose values and control labels. */
function strings(snapshot: ContextSnapshot): string[] {
  const out: string[] = []
  for (const element of snapshot.elements) {
    if (element.secure) continue
    const text = (element.role === 'AXStaticText' ? element.value ?? element.label : element.label).replace(/\s+/g, ' ').trim()
    if (text) out.push(text)
  }
  return out
}

function cuesIn(texts: string[]): string[] {
  const all = texts.join('\n')
  return CUES.filter(([pattern]) => pattern.test(all)).map(([, phrase]) => phrase)
}

function sender(texts: string[]): { name: string; address: string; marked: boolean } | null {
  for (let index = 0; index < texts.length; index++) {
    const marked = /^from:?\s/i.test(texts[index]) || (index > 0 && FROM_MARKER.test(texts[index - 1])) || (index > 1 && FROM_MARKER.test(texts[index - 2]))
    const named = NAMED_SENDER.exec(texts[index])
    if (named) {
      const address = normalizeEmail(named[2])
      if (address) return { name: named[1].trim(), address, marked }
    }
    const bare = BARE_SENDER.exec(texts[index])
    const address = bare && normalizeEmail(bare[1])
    if (address && index > 0) {
      const previous = texts[index - 1]
      // "Ravi Kumar" on one line, "<ravi@…>" on the next, as mail clients lay out a header.
      if (!FROM_MARKER.test(previous) && previous.length <= 80 && !previous.includes('@')) return { name: previous, address, marked }
    }
  }
  return null
}

export function extractClaim(snapshot: ContextSnapshot): ScreenClaim | null {
  if (!snapshot.elements.length) return null
  const texts = strings(snapshot)
  const from = sender(texts)
  // A sender line only counts inside something that is recognisably mail: a mail site, a mail app, or a "From" header.
  if (from && (from.marked || isMailHost(snapshot.url ?? '') || MAIL_APPS.has(snapshot.app.bundleId))) {
    return { kind: 'email', claimed: [from.name], channelType: 'email', channelValue: from.address, cues: cuesIn(texts) }
  }
  let protocol = ''
  try { protocol = new URL(snapshot.url ?? '').protocol } catch { /* Not a web page. */ }
  const host = protocol === 'https:' || protocol === 'http:' ? normalizeHost(snapshot.url!) : null
  if (!host) return null
  const page = toDistilledPage(snapshot, { webOnly: true })
  if (!isSensitive(classifyPage(page))) return null
  const headings = page.elements.filter((element) => element.kind === 'heading').slice(0, 3).map((element) => element.label)
  return { kind: 'page', claimed: [snapshot.window.title, ...headings].filter(Boolean), channelType: 'website', channelValue: host, cues: cuesIn(texts) }
}
