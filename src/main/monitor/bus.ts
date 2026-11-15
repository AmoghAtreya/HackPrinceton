/**
 * The learning monitor's event stream: one place where every model-side step
 * (LangGraph nodes, LangChain pipeline steps and retrievals, memory writes,
 * bandit decisions and rewards) is published for the Learning Monitor window
 * and any second device watching it.
 *
 * Events are display data only. Nothing reads them back to make decisions,
 * and personal values are masked before they enter the stream, because the
 * monitor may be shown to an audience or on another device.
 */

export type MonitorEvent =
  | { type: 'run'; phase: 'start' | 'end' | 'error'; runId: string; parentId?: string; name: string; system: 'langgraph' | 'langchain'; node?: string; graph?: string; durationMs?: number; error?: string }
  | { type: 'retrieval'; runId: string; query: string; durationMs: number; hits: Array<{ text: string; kind: string; score?: number }> }
  | { type: 'memory'; action: 'saved' | 'forgotten'; kind: string; key?: string; text: string }
  | { type: 'interrupt'; graph: string; kind: string; prompt: string }
  | { type: 'bandit'; pageType: string; armId: string; layout: string; propensity: number; mode: string; shares: Record<string, number>; source: 'llm' | 'rules'
      /** Per arm: learned reward noise E[σ²] and discounted number of ratings. */
      diagnostics?: Record<string, { noiseVariance: number; evidence: number }> }
  | { type: 'reward'; armId: string; layout: string; pageType: string; reward: number; rated: number; averageReward: number | null }
  | { type: 'note'; text: string }

export type StampedEvent = MonitorEvent & { seq: number; at: number }

/**
 * Mask personal values for display: prescription and card-like numbers keep
 * only their last two characters, dates of birth and emails are hidden.
 */
export function mask(text: string): string {
  return text
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, '•••@•••')
    .replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, '••/••/••••')
    // IDs like RX-48213, and long plain numbers (cards, accounts). Years such as 2027 stay readable.
    .replace(/\b([A-Z]{1,4}-?)(\d{1,})(\d{2})\b/gi, (_m, prefix: string, middle: string, tail: string) => prefix + '•'.repeat(Math.min(middle.length, 6)) + tail)
    .replace(/\b(\d{4,})(\d{2})\b/g, (_m, middle: string, tail: string) => '•'.repeat(Math.min(middle.length, 6)) + tail)
    .slice(0, 400)
}

export class LearningMonitor {
  private readonly events: StampedEvent[] = []
  private readonly listeners = new Set<(event: StampedEvent) => void>()
  private seq = 0
  private readonly capacity: number
  private readonly now: () => number

  constructor(capacity = 600, now: () => number = Date.now) { this.capacity = capacity; this.now = now }

  emit(event: MonitorEvent): void {
    const stamped = { ...sanitize(event), seq: ++this.seq, at: this.now() } as StampedEvent
    this.events.push(stamped)
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    for (const listener of this.listeners) {
      try { listener(stamped) } catch { /* A broken viewer must never affect the app. */ }
    }
  }

  /** Events after a sequence number, for a viewer that connects late or reconnects. */
  since(seq = 0): StampedEvent[] { return this.events.filter((event) => event.seq > seq) }

  subscribe(listener: (event: StampedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

function sanitize(event: MonitorEvent): MonitorEvent {
  switch (event.type) {
    case 'retrieval': return { ...event, query: mask(event.query), hits: event.hits.slice(0, 5).map((hit) => ({ ...hit, text: mask(hit.text) })) }
    case 'memory': return { ...event, text: mask(event.text) }
    case 'interrupt': return { ...event, prompt: mask(event.prompt) }
    case 'run': return event.error ? { ...event, error: mask(event.error) } : event
    case 'note': return { ...event, text: mask(event.text) }
    default: return event
  }
}
