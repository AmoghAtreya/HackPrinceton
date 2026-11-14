/**
 * Turns a chat reply into something pleasant to hear: no links or markdown,
 * and only the first few sentences, since the full reply stays on screen.
 */
export const SPEECH_TARGET_CHARS = 300
const MAX_SENTENCES = 3
export const REST_ON_SCREEN = 'The rest is on screen.'

export function prepareSpeech(text: string, targetChars = SPEECH_TARGET_CHARS): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')                       // code blocks
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')            // [label](url) → label
    .replace(/\bhttps?:\/\/\S+/gi, ' ')                      // bare links
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                      // headings
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')             // list markers
    .replace(/[*_`~>|]+/g, '')                               // emphasis, quotes, tables
    .replace(/[“”]/g, '"')
    .split(/\n+/).map((line) => line.trim()).filter(Boolean)
    // A line without closing punctuation (a list item or heading) still ends a thought.
    .map((line) => /[.!?:;]["')]?$/.test(line) ? line : line + '.')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  const sentences = cleaned.match(/[^.!?]+(?:[.!?]+["')]?|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [cleaned]
  let spoken = ''
  let used = 0
  for (const sentence of sentences) {
    if (used >= MAX_SENTENCES) break
    if (spoken && spoken.length + 1 + sentence.length > targetChars) break
    spoken = spoken ? spoken + ' ' + sentence : sentence
    used++
  }
  if (spoken.length > targetChars + 100) spoken = spoken.slice(0, targetChars).replace(/\s+\S*$/, '') + '…'
  return used < sentences.length || spoken.endsWith('…') ? `${spoken} ${REST_ON_SCREEN}` : spoken
}

/** A failed request, spoken briefly. */
export function failureSpeech(reason: string | null | undefined): string {
  const detail = reason ? prepareSpeech(reason, 160) : ''
  return detail ? `Sorry, that didn't work. ${detail}` : "Sorry, that didn't work."
}
