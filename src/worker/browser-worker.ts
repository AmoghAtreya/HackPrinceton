import { chromium, type BrowserContext, type Page } from 'playwright'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { flightDraftSchema, type WorkerCommand, type WorkerMessage, type FlightStep } from '../shared/flight-contracts.ts'
import { validateFlight } from '../main/browser/validation.ts'
import { alaskaSearch, failedSearch } from './alaska.ts'

const port = process.parentPort!
let context: BrowserContext | undefined
interface WorkerJob { id: string; controller: AbortController; page?: Page }
let active: WorkerJob | undefined
let closing = false
const waits = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
function send(message: WorkerMessage): void { port.postMessage(message) }
function check(job: WorkerJob): void {
  if (closing || active !== job || job.controller.signal.aborted) throw new Error('canceled')
}
function wait(type: string, actionId: string): Promise<void> {
  const key = type + actionId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waits.delete(key); reject(new Error('History acknowledgment timed out.')) }, 10000)
    waits.set(key, { resolve, reject, timer })
  })
}
function cancel(): void {
  const job = active
  if (!job) return
  job.controller.abort()
  for (const value of waits.values()) { clearTimeout(value.timer); value.reject(new Error('canceled')) }
  waits.clear()
  // Interrupt a pending Playwright call even if it never returns on its own.
  const page = job.page
  if (page) setTimeout(() => { void page.close().catch(() => {}) }, 2000).unref()
}
async function start(command: Extract<WorkerCommand, { type: 'start' }>): Promise<void> {
  if (active || closing) return
  const job: WorkerJob = { id: command.taskId, controller: new AbortController() }
  active = job
  async function action<T>(step: FlightStep, operation: () => Promise<T>, detail: string): Promise<T> {
    check(job)
    const actionId = randomUUID()
    const authorized = wait('action_authorized', actionId)
    send({ type: 'action_proposed', taskId: job.id, actionId, step })
    await authorized; check(job)
    const result = await operation()
    check(job)
    const saved = wait('result_saved', actionId)
    send({ type: 'action_result', taskId: job.id, actionId, step, detail })
    await saved; check(job)
    return result
  }
  try {
    const draft = flightDraftSchema.parse({ ...command.input, returnDate: command.input.returnDate ?? null, unsupportedPassengers: false })
    const input = validateFlight(draft).input
    if (!input) throw new Error('Invalid flight input.')
    await action('open_browser', async () => {
      if (!context) {
        context = await chromium.launchPersistentContext(command.profile, { headless: false, viewport: null, timeout: 30000 })
        context.on('close', () => { context = undefined })
      }
      check(job)
      job.page = await context.newPage()
      job.page.setDefaultTimeout(12000)
      job.page.setDefaultNavigationTimeout(30000)
      job.page.on('framenavigated', (frame) => {
        if (frame === job.page?.mainFrame()) {
          send({ type: 'page_navigated', taskId: job.id })
          const url = new URL(frame.url())
          if (active === job && url.protocol !== 'about:' && (url.protocol !== 'https:' || url.hostname !== 'www.alaskaair.com' || !['/search', '/search/', '/search/results'].includes(url.pathname))) cancel()
        }
      })
      job.page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}) })
    }, 'Visible Chromium opened with Triage’s dedicated profile.')
    const outcome = await alaskaSearch(job.page!, input, action, job.controller.signal)
    check(job)
    send({ type: 'workflow_result', taskId: job.id, outcome })
  } catch {
    if (job.controller.signal.aborted || closing) {
      await job.page?.close().catch(() => {})
      active = undefined
      send({ type: 'canceled', taskId: job.id })
    }
    else send({ type: 'workflow_result', taskId: job.id, outcome: await failedSearch(job.page) })
  } finally {
    if (job.controller.signal.aborted) await job.page?.close().catch(() => {})
    active = undefined
  }
}
port.on('message', ({ data }: { data: unknown }) => {
  if (!data || typeof data !== 'object' || !('type' in data)) return
  const command = data as WorkerCommand
  if (command.type === 'start') {
    if (!z.string().uuid().safeParse(command.taskId).success || typeof command.profile !== 'string') return
    void start(command)
  } else if (command.type === 'cancel' && command.taskId === active?.id) cancel()
  else if ((command.type === 'action_authorized' || command.type === 'result_saved') && command.taskId === active?.id) {
    const key = command.type + command.actionId
    const pending = waits.get(key)
    if (pending) { clearTimeout(pending.timer); waits.delete(key); pending.resolve() }
  } else if (command.type === 'close') {
    closing = true; cancel()
    void (async () => { try { await context?.close() } finally { process.exit(0) } })()
  }
})
