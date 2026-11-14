import { Annotation, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph'
import { RiskTier } from '../../shared/simplifier-contracts.ts'
import type { MemoryService } from '../memory/service.ts'
import type { RefillDriver } from './pharmacy-driver.ts'

/**
 * "Refill my blood pressure medicine" as a LangGraph state machine.
 *
 *   recall → gather ⟲ → open → fill → confirm → submit → remember → END
 *                                        │          └─(page gone after restart)→ open
 *                                        └─(no / blocked)→ END
 *
 * - recall:  looks the person's details up in memory via a LangChain retriever.
 * - gather:  asks for ONE missing detail at a time (interrupt), saves the answer
 *            to memory so the next refill needs no questions, and loops.
 * - confirm: pauses (interrupt) with a read-back and waits for an explicit yes.
 *            The risk tier of the submit button comes from rules over the page,
 *            never from a model, and money/credential tier is always refused.
 * - Every step appends to `steps`, and the checkpointer saves state after each
 *   node, which is what the History tab's progress tracking and "Where was I?"
 *   read back, including after a restart.
 */

const replace = <T>(fallback: () => T) => Annotation<T>({ reducer: (_old: T, next: T) => next, default: fallback })

export const RefillState = Annotation.Root({
  request: Annotation<string>,
  medication: replace<string | null>(() => null),
  rx: replace<string | null>(() => null),
  name: replace<string | null>(() => null),
  dateOfBirth: replace<string | null>(() => null),
  store: replace<string | null>(() => null),
  pickupTime: replace<string | null>(() => null),
  usedRecipe: replace<boolean>(() => false),
  filled: replace<Array<{ label: string; value: string }>>(() => []),
  formOpen: replace<boolean>(() => false),
  approved: replace<boolean | null>(() => null),
  confirmation: replace<string | null>(() => null),
  outcome: replace<'in_progress' | 'submitted' | 'cancelled' | 'blocked' | 'failed'>(() => 'in_progress'),
  steps: Annotation<string[]>({ reducer: (old: string[], next: string[]) => old.concat(next), default: () => [] })
})
export type RefillValues = typeof RefillState.State

/** What an interrupt asks the person. Rendered as a chat reply. */
export type RefillPrompt =
  | { kind: 'question'; field: MissingField; question: string }
  | { kind: 'confirm'; summary: string }

export const REFILL_STEP_COUNT = 7
type MissingField = 'medication' | 'rx' | 'name' | 'dateOfBirth' | 'store' | 'pickupTime'

const afterIs = (text: string) => (/\bis\b\s*(.+)$/i.exec(text)?.[1] ?? text).trim().replace(/[.!]+$/, '')
const CANCEL = /^(?:cancel|stop|never ?mind|no thanks|forget it|quit)\b/i
const YES = /^(?:yes|yeah|yep|sure|ok(?:ay)?|go ahead|please do|do it|send it|submit|confirm)\b/i

export function medicationFromRequest(request: string): string | null {
  const match = /\b(?:refill|reorder|renew)\s+(?:my\s+|the\s+)?(.+?)(?:\s+(?:prescription|medication|medicine|meds|pills))?\s*(?:please)?\s*[.!?]*$/i.exec(request.trim())
  const name = match?.[1]?.trim()
  return name && !/^(?:prescription|medication|medicine|meds|pills)$/i.test(name) ? name : null
}

function pickupFrom(text: string): string | null {
  return /\bmorning|\bam\b/i.test(text) ? 'Morning' : /\bafternoon|\bpm\b/i.test(text) ? 'Afternoon' : /\bevening|\bnight/i.test(text) ? 'Evening' : null
}

const QUESTIONS: Record<MissingField, (s: RefillValues) => string> = {
  medication: () => 'Which medicine would you like to refill?',
  rx: (s) => `What is the prescription number on your ${s.medication ?? 'medicine'} bottle? It usually starts with RX.`,
  name: () => 'What is your full name, as it appears on the prescription?',
  dateOfBirth: () => 'What is your date of birth? For example 04/12/1951.',
  store: () => 'Which CareWell store should it go to: Main Street, Riverside Plaza, or Oak Avenue?',
  pickupTime: () => 'Would you like to pick it up in the morning, afternoon, or evening?'
}

function missing(state: RefillValues): MissingField | null {
  for (const field of ['medication', 'rx', 'name', 'dateOfBirth', 'store', 'pickupTime'] as const) if (!state[field]) return field
  return null
}

export function createRefillGraph(deps: { memory: MemoryService; driver: RefillDriver; checkpointer: BaseCheckpointSaver; today?: () => Date }) {
  const { memory, driver } = deps
  const today = deps.today ?? (() => new Date())

  const recall = async (state: RefillValues) => {
    const wanted = medicationFromRequest(state.request)
    // LangChain retriever over preference memories; scored match on the request.
    const docs = await memory.retriever('preference', 5).invoke(state.request)
    const medications = docs.filter((doc) => String(doc.metadata.key ?? '').startsWith('medication:'))
    const match = wanted
      ? medications.find((doc) => String(doc.metadata.medication ?? '').toLowerCase().includes(wanted.toLowerCase()) || wanted.toLowerCase().includes(String(doc.metadata.medication ?? '').toLowerCase()))
      : medications.length === 1 ? medications[0] : undefined
    const pick = (key: string) => memory.preference(key)?.text
    const store = pick('pharmacy')
    const recipe = memory.recipe(driver.site, 'refill')
    return {
      medication: match ? String(match.metadata.medication) : wanted,
      rx: match ? String(match.metadata.rx ?? '') || null : null,
      name: pick('name') ? afterIs(pick('name')!) : null,
      dateOfBirth: pick('date_of_birth') ? afterIs(pick('date_of_birth')!) : null,
      store: store ? afterIs(store) : null,
      pickupTime: pick('pickup_time') ? pickupFrom(pick('pickup_time')!) : null,
      usedRecipe: Boolean(recipe),
      steps: [recipe ? 'Looked up your details and the steps from last time' : 'Looked up your details in memory']
    }
  }

  const gather = async (state: RefillValues) => {
    const field = missing(state)
    if (!field) return {}
    const answer = String(interrupt<RefillPrompt, string>({ kind: 'question', field, question: QUESTIONS[field](state) }) ?? '').trim()
    if (CANCEL.test(answer)) return { outcome: 'cancelled' as const, steps: ['Stopped at your request'] }
    if (!answer) return {}
    switch (field) {
      case 'medication': return { medication: answer.replace(/^(?:my|the)\s+/i, '') }
      case 'rx': {
        const rx = /([A-Z0-9-]*\d[A-Z0-9-]*)/i.exec(answer)?.[1]?.toUpperCase()
        if (!rx) return {}
        await memory.remember('preference', `my ${state.medication} medication is ${rx}`, { key: 'medication:' + state.medication!.toLowerCase(), medication: state.medication!, rx })
        return { rx, steps: ['Saved your prescription number for next time'] }
      }
      case 'name':
        await memory.remember('preference', `my name is ${answer}`, { key: 'name' })
        return { name: answer }
      case 'dateOfBirth':
        await memory.remember('preference', `my date of birth is ${answer}`, { key: 'date_of_birth' })
        return { dateOfBirth: answer }
      case 'store':
        await memory.remember('preference', `my pharmacy is CareWell ${answer}`, { key: 'pharmacy' })
        return { store: answer }
      case 'pickupTime': {
        const time = pickupFrom(answer)
        if (!time) return {}
        await memory.remember('preference', `I prefer to pick up in the ${time.toLowerCase()}`, { key: 'pickup_time' })
        return { pickupTime: time }
      }
    }
  }

  const open = async () => {
    await driver.open()
    return { formOpen: true, steps: ['Opened the CareWell refill page'] }
  }

  const fill = async (state: RefillValues) => {
    const filled = await driver.fill({ name: state.name!, dateOfBirth: state.dateOfBirth!, rx: state.rx!, store: state.store!, pickupTime: state.pickupTime! })
    return { filled, steps: ['Filled in the refill form'] }
  }

  const confirm = async (state: RefillValues) => {
    const tier = await driver.submitTier()
    if (tier >= RiskTier.MoneyOrCredentials) {
      return { approved: false, outcome: 'blocked' as const, steps: ['Stopped: this page asks for payment or a password, which I never submit'] }
    }
    const summary = [`Here is what I filled in for your ${state.medication} refill at CareWell:`,
      ...state.filled.map((item) => `• ${item.label}: ${item.value}`), 'You pay at pickup.', 'Shall I send the refill request? Reply yes or no.'].join('\n')
    const answer = String(interrupt<RefillPrompt, string>({ kind: 'confirm', summary }) ?? '').trim()
    return YES.test(answer)
      ? { approved: true, steps: ['You said yes to sending it'] }
      : { approved: false, outcome: 'cancelled' as const, steps: ['You chose not to send it; nothing was submitted'] }
  }

  const submit = async () => {
    try {
      const { confirmation } = await driver.submit()
      return { confirmation, outcome: 'submitted' as const, steps: [`Sent the refill request (confirmation ${confirmation})`] }
    } catch {
      // Most often: Triage restarted while waiting for "yes", so the browser
      // page is gone. Refill the form and ask again; never submit blind.
      return { formOpen: false, approved: null, steps: ['The pharmacy page had closed, so I am filling it in again'] }
    }
  }

  const remember = async (state: RefillValues) => {
    await memory.saveRecipe({ site: driver.site, task: 'refill', steps: [
      { action: 'open', label: 'Open the refill page' }, { action: 'fill', field: 'name', label: 'Full name' },
      { action: 'fill', field: 'dateOfBirth', label: 'Date of birth' }, { action: 'fill', field: 'rx', label: 'Prescription number' },
      { action: 'select', field: 'store', label: 'Pickup store' }, { action: 'select', field: 'pickupTime', label: 'Pickup time' },
      { action: 'confirm', label: 'Ask before sending' }, { action: 'submit', label: 'Request refill' }
    ] })
    await memory.remember('fact', `Refilled ${state.medication} at CareWell on ${today().toDateString()}, confirmation ${state.confirmation}`, {
      key: 'last_refill:' + String(state.medication).toLowerCase()
    })
    return { steps: ['Saved this refill so next time is quicker'] }
  }

  return new StateGraph(RefillState)
    .addNode('recall', recall)
    .addNode('gather', gather)
    .addNode('open', open)
    .addNode('fill', fill)
    .addNode('confirm', confirm)
    .addNode('submit', submit)
    .addNode('remember', remember)
    .addEdge(START, 'recall')
    .addEdge('recall', 'gather')
    .addConditionalEdges('gather', (s) => (s.outcome === 'cancelled' ? END : missing(s) ? 'gather' : 'open'), ['gather', 'open', END])
    .addEdge('open', 'fill')
    .addEdge('fill', 'confirm')
    .addConditionalEdges('confirm', (s) => (s.approved ? 'submit' : END), ['submit', END])
    .addConditionalEdges('submit', (s) => (s.outcome === 'submitted' ? 'remember' : 'open'), ['remember', 'open'])
    .addEdge('remember', END)
    .compile({ checkpointer: deps.checkpointer })
}
