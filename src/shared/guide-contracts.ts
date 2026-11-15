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

const GUIDE_REQUEST = /^(?:(?:hey|hi|ok|okay|so|please|triage|can you|could you|would you|will you)\s+)*(?:help me(?: to| how to)?|walk me through(?: how to)?|show me how to|guide me through|guide me to|teach me how to)\s+(.+?)$/
/** Asking for an explanation of the screen, not a task: handled by Explain screen and the chatbot. */
const NOT_A_TASK = /^(?:with (?:this|that|it|my screen|this (?:page|screen))|understand\b|out\b|please\b)/

/**
 * The goal of a plain request for step-by-step help ("help me attach a photo",
 * "walk me through sending this"), or null. These start a guide without asking
 * the router, so a fast model can't answer them with a long list instead.
 */
export function guideGoal(text: string): string | null {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[?!.]+$/, '').replace(/\s+/g, ' ').trim()
  const goal = GUIDE_REQUEST.exec(normalized)?.[1]?.replace(/\s+(?:please|for me|thanks|thank you)$/, '').trim()
  if (!goal || goal.split(' ').length < 2 || NOT_A_TASK.test(goal) || goal.length > 200) return null
  return goal
}

const SHOW_AGAIN = /^(?:show me|show me again|show me where|show me where it is|where is it|where|where's that|point to it|point at it|point it out|show it to me|highlight it|draw it|draw the box|give me an arrow|give me the arrow|arrow|show me the arrow|show the arrow|again|say that again|i can't see it|i don't see it|i can't find it|i don't see the box|which one|where do i click|where should i click)$/

/** True when a message asks to see the current step's box again ("show me", "where is it", "give me an arrow"). */
export function isShowAgain(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:hey|ok|okay|so|um+|uh+|please|triage|can you|could you|would you|just)\s+)+(?=\S)/, '').replace(/\s+(?:please|for me|again please|thanks|triage)$/, '')
  return SHOW_AGAIN.test(normalized)
}

/** True when a whole message only means "show me the next step" ("next", "done", "what now"). */
export function isNextStep(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:okay|ok|um+|uh+|so|well|triage)\s+)+(?=\S)/, '').replace(/\s+(?:please|thanks|thank you|triage)$/, '')
  return NEXT_STEP.test(normalized) || NEXT_STEP.test(text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim())
}
