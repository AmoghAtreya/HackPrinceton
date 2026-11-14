/** Guided help: Triage walks the person through a task one step at a time, outlining each control. */
export interface GuideState {
  conversationId: string
  /** What the person asked to do, in a few words. */
  goal: string
  /** How many steps have been shown so far. */
  step: number
  /** The request that produced the current step; its reply is the step's text. */
  taskId: string | null
  /** True when the guide was started by voice, so each step is read aloud. */
  spoken: boolean
}

export const GUIDE_MAX_STEPS = 12
/** A guide nobody has touched for this long is over. */
export const GUIDE_IDLE_MS = 10 * 60 * 1000
/** After the outlined control is clicked, wait for the screen to change before looking again. */
export const GUIDE_CLICK_DELAY_MS = 1500

const NEXT_STEP = /^(?:next|next step|next one|done|i(?:'m| am) done|i did it|i did that|did it|ok|okay|okay done|ok done|got it|what now|what next|what's next|what is next|now what|and then|then what|continue|keep going|go on|ready)$/

/** True when a whole message only means "show me the next step" ("next", "done", "what now"). */
export function isNextStep(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:okay|ok|um+|uh+|so|well|triage)\s+)+(?=\S)/, '').replace(/\s+(?:please|thanks|thank you|triage)$/, '')
  return NEXT_STEP.test(normalized) || NEXT_STEP.test(text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim())
}
