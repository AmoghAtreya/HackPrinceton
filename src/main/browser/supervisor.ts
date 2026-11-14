import { workerMessageSchema, steps, stepLabels, type FlightSearchInput, type FlightOutcome, type WorkerCommand, type FlightStep } from '../../shared/flight-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'

export interface BrowserRunner {
  run(taskId: string, input: FlightSearchInput, signal: AbortSignal, record: (type: string, detail: string, data?: object) => void, progress: (text: string) => void): Promise<FlightOutcome>
  close(): Promise<void>
}
export interface WorkerTransport {
  postMessage(message: WorkerCommand): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}
interface Job {
  id: string; signal: AbortSignal; resolve: (outcome: FlightOutcome) => void; reject: (error: unknown) => void
  record: (type: string, detail: string, data?: object) => void; progress: (text: string) => void
  pending?: { id: string; step: FlightStep }; seen: Set<string>; lastStep: number; expected: FlightStep[]
  abort: () => void; timer?: ReturnType<typeof setTimeout>; killTimer?: ReturnType<typeof setTimeout>
}
export class BrowserSupervisor implements BrowserRunner {
  private worker?: WorkerTransport
  private job?: Job
  private closing?: Promise<void>
  private exitResolve?: () => void
  private spawn: () => WorkerTransport
  private profile: string
  private navigated: () => void
  constructor(spawn: () => WorkerTransport, profile: string, navigated = () => {}) { this.spawn = spawn; this.profile = profile; this.navigated = navigated }

  private ensure(): WorkerTransport {
    if (this.worker) return this.worker
    const worker = this.spawn()
    this.worker = worker
    worker.on('message', (message) => { if (this.worker === worker) this.receive(message) })
    worker.on('exit', () => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.settle(new AppProblem('browser_closed', 'Triage’s browser worker exited. Any unverified action has an unknown outcome. No action was replayed.'))
      this.exitResolve?.(); this.exitResolve = undefined
    })
    return worker
  }

  run(id: string, input: FlightSearchInput, signal: AbortSignal, record: Job['record'], progress: Job['progress']): Promise<FlightOutcome> {
    if (this.job || this.closing) return Promise.reject(new AppProblem('browser_busy', 'The previous browser task is still stopping. Try again in a moment.'))
    if (signal.aborted) return Promise.reject(new AppProblem('stopped', 'Search stopped.'))
    return new Promise((resolve, reject) => {
      const job: Job = { id, signal, resolve, reject, record, progress, seen: new Set(), lastStep: -1, expected: steps.filter((step) => step !== 'return' || input.tripType === 'round_trip'),
        abort: () => this.cancel(id) }
      this.job = job
      signal.addEventListener('abort', job.abort, { once: true })
      job.timer = setTimeout(() => {
        this.cancel(id)
      }, 180000)
      try { this.ensure().postMessage({ type: 'start', taskId: id, input, profile: this.profile }) }
      catch {
        this.settle(new AppProblem('browser_start', 'Could not start the browser worker. Install Chromium with npm run browser:install.'))
        this.terminate()
      }
    })
  }

  private receive(raw: unknown): void {
    const job = this.job
    const parsed = workerMessageSchema.safeParse(raw)
    if (!parsed.success) { if (job) this.failProtocol(); return }
    const message = parsed.data
    if (message.type === 'page_navigated') { this.navigated(); return }
    if (!job) return
    if (message.taskId !== job.id) return
    if (message.type === 'canceled') {
      this.settle(new AppProblem('stopped', 'Search stopped. A submitted search cannot be undone.'))
      return
    }
    if (job.signal.aborted || job.killTimer) return
    try {
      if (message.type === 'action_proposed') {
        const index = job.expected.indexOf(message.step)
        if (job.pending || job.seen.has(message.actionId) || index !== job.lastStep + 1) { this.failProtocol(); return }
        job.record('action_pending', stepLabels[message.step], { actionId: message.actionId, step: message.step })
        job.pending = { id: message.actionId, step: message.step }
        job.seen.add(message.actionId); job.lastStep = index
        job.progress(stepLabels[message.step])
        if (!job.signal.aborted) this.worker!.postMessage({ type: 'action_authorized', taskId: job.id, actionId: message.actionId })
      } else if (message.type === 'action_result') {
        if (job.pending?.id !== message.actionId || job.pending.step !== message.step) { this.failProtocol(); return }
        job.record('action_observed', message.detail, { actionId: message.actionId, step: message.step })
        job.pending = undefined
        this.worker!.postMessage({ type: 'result_saved', taskId: job.id, actionId: message.actionId })
      } else if (message.type === 'workflow_result') {
        if ((message.outcome.status === 'results' || message.outcome.status === 'no_results') && (job.pending || job.lastStep !== job.expected.indexOf('verify'))) {
          this.failProtocol(); return
        }
        job.record('flight_outcome', message.outcome.detail, { outcome: message.outcome })
        this.settle(undefined, message.outcome)
      }
    } catch (error) {
      try { this.worker?.postMessage({ type: 'cancel', taskId: job.id }) } catch { /* The worker may already have exited. */ }
      this.settle(error)
      this.terminate()
    }
  }

  private failProtocol(): void {
    this.settle(new AppProblem('browser_protocol', 'Browser state could not be verified. Execution stopped without replay.'))
    this.terminate()
  }
  private terminate(): void {
    const worker = this.worker
    this.worker = undefined
    try { worker?.kill() } catch { /* Never reuse an unreachable worker. */ }
    const finish = this.exitResolve
    this.exitResolve = undefined
    finish?.()
  }
  private cancel(id: string): void {
    const job = this.job
    if (!job || job.id !== id || job.killTimer) return
    job.killTimer = setTimeout(() => {
      this.settle(new AppProblem('browser_timeout', 'Browser stopped after its cancellation deadline. Any unverified action has an unknown outcome.'))
      this.terminate()
    }, 4000)
    try { this.worker?.postMessage({ type: 'cancel', taskId: id }) } catch { /* Kill above is the fallback. */ }
  }
  private settle(error?: unknown, outcome?: FlightOutcome): void {
    const job = this.job
    if (!job) return
    clearTimeout(job.timer); clearTimeout(job.killTimer)
    job.signal.removeEventListener('abort', job.abort)
    this.job = undefined
    if (error) job.reject(error)
    else job.resolve(outcome!)
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    if (!this.worker) return Promise.resolve()
    const worker = this.worker
    let resolve!: () => void
    const closing = new Promise<void>((done) => { resolve = done })
    this.closing = closing
    const finish = () => {
      clearTimeout(timer)
      if (this.worker === worker) this.worker = undefined
      this.settle(new AppProblem('browser_closed', 'Triage’s browser closed. Unverified actions were not replayed.'))
      if (this.exitResolve === finish) this.exitResolve = undefined
      this.closing = undefined
      resolve()
    }
    const timer = setTimeout(() => { finish(); worker.kill() }, 5000)
    this.exitResolve = finish
    if (this.job) this.cancel(this.job.id)
    try { worker.postMessage({ type: 'close' }) } catch { finish(); worker.kill() }
    return closing
  }
}
