/**
 * Voice shortcuts handled locally, before anything reaches the model: fast,
 * free and predictable. Everything that is not a shortcut goes to the chatbot
 * unchanged, which decides between a reply and a flight search itself.
 *
 * Control commands (stop, new conversation) only match when they are the whole
 * utterance, so "stop my subscription" is still sent to the chatbot.
 */
export type VoiceIntent =
  | { kind: 'stop' }
  | { kind: 'new_conversation' }
  /** Capture the screen and explain it. */
  | { kind: 'explain_screen' }
  /** Capture the screen and point at the control the user asked about. */
  | { kind: 'show_me_where' }
  | { kind: 'chat' }

const FILLER_PREFIX = /^(?:(?:hey|hi|okay|ok|um+|uh+|so|well|please|triage|can you|could you|would you|will you)\s+)+/
const POLITE_SUFFIX = /\s+(?:please|for me|thanks|thank you)$/

const STOP = /^(?:stop|stop it|stop that|stop now|cancel|cancel that|cancel it|never ?mind|forget it|that's enough|enough)$/
const NEW_CONVERSATION = /^(?:start over|start again|new (?:conversation|chat)|start a new (?:conversation|chat)|clear (?:the |this )?(?:chat|conversation))$/
const EXPLAIN_SCREEN = /^(?:explain|describe|read|tell me about) (?:my|this|the) (?:screen|page|window)$|^what(?:'s| is) (?:on )?(?:my|this|the) (?:screen|page)$|^what am i looking at$|^(?:explain this|what is this|what's this|what does this (?:page |screen )?(?:say|mean))$|^help me (?:understand|with) (?:this|my screen|this page|this screen)$/
const SHOW_ME_WHERE = /^show me (?:where|how)\b|^where (?:do|can|should) i (?:click|tap|press|find|go|type)\b|^where(?:'s| is| are) the\b|^(?:point (?:me )?(?:to|at)|highlight) (?:the )?\S|^how do i find the\b|^which (?:button|link) (?:do|should) i\b|^what (?:do|should) i click\b/

/** Lowercases, strips punctuation, leading filler words and polite endings. */
export function normalizeUtterance(text: string): string {
  let normalized = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  normalized = normalized.replace(FILLER_PREFIX, '')
  while (POLITE_SUFFIX.test(normalized)) normalized = normalized.replace(POLITE_SUFFIX, '')
  return normalized.trim()
}

export function matchVoiceIntent(text: string): VoiceIntent {
  const normalized = normalizeUtterance(text)
  if (!normalized) return { kind: 'chat' }
  if (STOP.test(normalized)) return { kind: 'stop' }
  if (NEW_CONVERSATION.test(normalized)) return { kind: 'new_conversation' }
  if (EXPLAIN_SCREEN.test(normalized)) return { kind: 'explain_screen' }
  if (SHOW_ME_WHERE.test(normalized)) return { kind: 'show_me_where' }
  return { kind: 'chat' }
}
