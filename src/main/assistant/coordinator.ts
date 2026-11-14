import type { BrowserRunner } from '../browser/supervisor.ts'
import { validateFlight } from '../browser/validation.ts'
import { HIGHLIGHT_LOST_MESSAGE, highlightSource, type HighlightController, type HighlightPlan } from '../screen/highlight.ts'
import type { ElementAnchor, HighlightReply } from '../../shared/highlight-contracts.ts'
import { locateElements } from '../context/locate.ts'
import type { ContextLookup } from '../context/paired-capture.ts'
import type { ShakeTrigger } from '../../shared/shake-contracts.ts'
import type { ScreenAccess, ScreenImage, ScreenPreview } from '../../shared/screen-contracts.ts'
import type { ActiveRequest, AssistantState, LearningSummary, SendReceipt } from '../../shared/assistant-contracts.ts'
import { Credentials } from './credentials.ts'
import { HistoryStore } from './history.ts'
import type { ModelGateway } from './model.ts'
import { AppProblem, publicProblem } from './errors.ts'
import { connectSchema, idSchema, modelSchema, rateSchema, sendSchema, validated } from './schemas.ts'
import { redact } from './redaction.ts'
import { resolveDestination } from '../../shared/destinations.ts'
import { describeResult, parseSimplifyCommand, type SimplifierService, type SimplifyCommand } from '../simplifier/service.ts'
import { describeScreenResult, type ScreenSimplifier } from '../simplifier/screen.ts'

// Triage is single-user on this Mac; the simplifier keys its learning by this ID.
const LOCAL_USER = 'local-user'

interface RunningRequest extends ActiveRequest {
  highlight?: boolean
  highlightRevision?: number
  expectedDisplayId?: string
  controller: AbortController
  deadline?: ReturnType<typeof setTimeout>
  simplify?: SimplifyCommand
  /** Simplify the page frontmost in the user's own browser, without asking the model to route. */
  simplifyScreen?: boolean
}

export class AssistantCoordinator {
  readonly history: HistoryStore
  private credentials: Credentials
  private gateway: ModelGateway
  private changed: (state: AssistantState) => void
  private active: RunningRequest | null = null
  private revision = 0
  private storageError?: string
  private connecting: AbortController | null = null
  private disposed = false
  private requestTimeout: number
  private highlights?: HighlightController
  private offHighlights?: () => void
  private offLost?: () => void
  private contexts?: ContextLookup
  private gestureRequest?: SendReceipt
  private browser?: BrowserRunner
  private openPage?: (url: string) => Promise<void>
  private screens?: ScreenAccess
  private simplifier?: SimplifierService
  private screenSimplifier?: Pick<ScreenSimplifier, 'simplify' | 'forget'>

  constructor(options: {
    history: HistoryStore; credentials: Credentials; gateway: ModelGateway
    changed: (state: AssistantState) => void; browser?: BrowserRunner; requestTimeout?: number; screens?: ScreenAccess; highlights?: HighlightController
    simplifier?: SimplifierService
    /** Simplifies the page in front of the user from an accessibility snapshot. */
    screenSimplifier?: Pick<ScreenSimplifier, 'simplify' | 'forget'>
    /** Accessibility snapshots paired with screenshots; without it highlights are pixel boxes only. */
    contexts?: ContextLookup
    /** Opens a vetted https URL in the user's own browser. */
    openPage?: (url: string) => Promise<void>
  }) {
    this.simplifier = options.simplifier
    this.screenSimplifier = options.screenSimplifier
    this.browser = options.browser
    this.openPage = options.openPage
    this.highlights = options.highlights
    this.offHighlights = options.highlights?.onChange(() => this.emit())
    this.contexts = options.contexts
    this.offLost = options.highlights?.onLost((state) => {
      if (this.disposed) return
      try { if (this.history.note(state.taskId, 'highlight_lost', HIGHLIGHT_LOST_MESSAGE)) this.emit() }
      catch { this.blockStorage() }
    })
    this.screens = options.screens
    this.history = options.history
    this.credentials = options.credentials
    this.gateway = options.gateway
    this.changed = options.changed
    this.requestTimeout = options.requestTimeout ?? 60000
  }

  snapshot(): AssistantState {
    return {
      config: this.credentials.snapshot(), revision: this.revision,
      active: this.active ? { id: this.active.id, conversationId: this.active.conversationId, startedAt: this.active.startedAt, stage: this.active.stage, progress: this.active.progress } : null,
      ...(this.storageError ? { storageError: this.storageError } : {}),
      ...(this.gestureRequest ? { gestureRequest: this.gestureRequest } : {}),
      ...(this.highlights?.snapshot() ? { highlight: this.highlights.snapshot()! } : {})
    }
  }

  private emit(): void {
    this.revision++
    if (!this.disposed) this.changed(this.snapshot())
  }

  private idle(): void {
    if (this.disposed) throw new AppProblem('closed', 'Triage is closing.')
    if (this.active || this.connecting) throw new AppProblem('busy', 'Finish or stop the current request first.')
  }

  private transition(request: RunningRequest, stage: 'thinking' | 'browser'): void {
    if (this.active !== request || request.controller.signal.aborted || this.disposed) throw new AppProblem('not_active', 'This request is no longer active.')
    const allowed = request.stage === 'capturing' && stage === 'thinking' || request.stage === 'thinking' && stage === 'browser'
    if (!allowed) throw new AppProblem('invalid_transition', 'The request state could not be verified. Start a new request.')
    this.history.activity(request.id, 'request_status', stage === 'browser' ? 'Starting flight search.' : 'Thinking…', { stage })
    request.stage = stage
    this.emit()
  }

  async connect(input: unknown) {
    const { key, remember } = validated(connectSchema, input)
    this.idle()
    const controller = new AbortController()
    this.connecting = controller
    const deadline = setTimeout(() => controller.abort(), 20000)
    try {
      const models = await this.gateway.models(key, controller.signal)
      if (controller.signal.aborted || this.disposed) throw new AppProblem('connection_timeout', 'Key verification timed out or was canceled. Try again.')
      const config = await this.credentials.connect(key, remember, models)
      if (this.disposed) {
        this.credentials.dispose()
        throw new AppProblem('closed', 'Triage closed before connection completed.')
      }
      this.emit()
      return config
    } finally {
      clearTimeout(deadline)
      this.connecting = null
    }
  }

  removeKey() {
    this.idle()
    const config = this.credentials.remove()
    this.emit()
    return config
  }

  selectModel(input: unknown) {
    this.idle()
    const config = this.credentials.select(validated(modelSchema, input))
    this.emit()
    return config
  }

  clearHighlight(): void { this.highlights?.clear() }

  learning(): LearningSummary {
    if (!this.simplifier) return { entries: [], rated: 0, averageReward: null, locked: [] }
    return this.simplifier.learning(LOCAL_USER)
  }

  rateSimplification(input: unknown): LearningSummary {
    const { decisionId, helpful } = validated(rateSchema, input)
    if (!this.simplifier) throw new AppProblem('simplifier_unavailable', 'Page simplification is unavailable in this build.')
    const summary = this.simplifier.rate(LOCAL_USER, decisionId, helpful)
    this.screenSimplifier?.forget(decisionId)
    this.emit()
    return summary
  }

  send(input: unknown): SendReceipt { return this.accept(input) }

  /** "Simplify this page" from the menu bar or a shake: the same flow the model can route to from chat. */
  simplifyPage(): SendReceipt {
    this.idle()
    if (this.storageError) throw new AppProblem('storage', this.storageError)
    if (!this.screenSimplifier) throw new AppProblem('simplifier_unavailable', 'Simplifying the page in front is unavailable in this build.')
    const key = this.credentials.getKey()
    const model = this.credentials.snapshot().model
    if (!model) throw new AppProblem('missing_model', 'Connect your key and choose an available model in Settings.')
    return this.start({ text: 'Simplify this page' }, key, model, undefined, undefined, undefined, 'chat', undefined, true)
  }

  private accept(input: unknown): SendReceipt {
    const request = validated(sendSchema, input)
    this.idle()
    if (this.storageError) throw new AppProblem('storage', this.storageError)
    const key = this.credentials.getKey()
    const model = this.credentials.snapshot().model
    if (!model) throw new AppProblem('missing_model', 'Connect your key and choose an available model in Settings.')
    let image: ScreenImage | undefined
    if (request.captureId) {
      if (!this.screens) throw new AppProblem('screen_unavailable', 'Screen capture is unavailable.')
      image = this.screens.take(request.captureId)
    }
    // Local command, handled without asking Claude to route it. Parsed here so a
    // bad address is reported immediately instead of after a model call.
    const simplify = !image && this.simplifier ? parseSimplifyCommand(request.text) : null
    return this.start(request, key, model, image, undefined, undefined, request.source ?? 'chat', simplify ?? undefined)
  }

  shake(trigger: ShakeTrigger, instruction: string, capture: () => Promise<ScreenPreview>, mode: 'explain' | 'highlight' = 'explain'): SendReceipt | null {
    if (this.disposed || this.storageError) return null
    let key = ''
    let problem: string | undefined
    try { key = this.credentials.getKey() } catch (error) { problem = publicProblem(error).message }
    const model = this.credentials.snapshot().model
    if (this.active || this.connecting) problem = 'Shake skipped: finish or stop the current request first. No screenshot was taken.'
    if (!model && !problem) problem = 'Connect your key and choose an available model in Settings.'
    const gesture = { ...trigger, point: { ...trigger.point }, instruction: redact(instruction, [key]) }
    if (problem) {
      try {
        const receipt = this.history.begin('[Shake to Help] ' + gesture.instruction, model || 'not-configured', undefined, undefined, gesture)
        this.history.finish(receipt.taskId, 'failed', problem)
        if (!this.active && !this.connecting) this.gestureRequest = receipt
        this.emit()
        return receipt
      } catch { this.blockStorage(); return null }
    }
    return this.start({ text: gesture.instruction, mode }, key, model, undefined, gesture, capture)
  }

  private start(request: { text: string; conversationId?: string; mode?: 'explain' | 'highlight' }, key: string, model: string,
    image?: ScreenImage, gesture?: ShakeTrigger & { instruction: string }, capture?: () => Promise<ScreenPreview>, source: 'chat' | 'voice' = 'chat',
    simplify?: SimplifyCommand, simplifyScreen = false): SendReceipt {
    this.highlights?.clear()
    let receipt: SendReceipt
    try {
      receipt = this.history.begin(redact((gesture ? '[Shake to Help] ' : request.mode === 'highlight' ? '[Show me where] ' : image ? '[Screen explanation] ' : '') + request.text, [key]), model, request.conversationId, image?.metadata, gesture, source)
      this.history.activity(receipt.taskId, 'request_status', capture ? 'Capturing screen…' : 'Thinking…', { stage: capture ? 'capturing' : 'thinking' })
    }
    catch (error) {
      if (error instanceof AppProblem && error.code === 'storage') this.blockStorage()
      throw error
    }
    const active: RunningRequest = {
      id: receipt.taskId, conversationId: receipt.conversationId,
      startedAt: Date.now(), stage: capture ? 'capturing' : 'thinking', controller: new AbortController(),
      expectedDisplayId: gesture?.displayId, highlight: request.mode === 'highlight', highlightRevision: this.highlights?.revision,
      ...(simplify ? { simplify } : {}), ...(simplifyScreen ? { simplifyScreen } : {})
    }
    this.active = active
    if (gesture) this.gestureRequest = receipt
    active.deadline = setTimeout(() => {
      if (this.active?.id !== active.id) return
      this.finish(active, 'failed', 'The reply timed out. You can try again.')
    }, this.requestTimeout)
    this.emit()
    void this.run(active, key, model, image, capture)
    return receipt
  }

  private async run(request: RunningRequest, key: string, model: string, image?: ScreenImage, capture?: () => Promise<ScreenPreview>): Promise<void> {
    try {
      if (capture) {
        const preview = await capture()
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) {
          this.screens?.discard?.(preview.metadata.id)
          return
        }
        if (!this.screens) throw new AppProblem('screen_unavailable', 'Screen capture is unavailable.')
        image = this.screens.take(preview.metadata.id)
        if (image.metadata.displayId !== request.expectedDisplayId) throw new AppProblem('display_changed', 'The display changed during the shake. Try again on the intended display.')
        this.history.attachCapture(request.id, image.metadata)
        this.transition(request, 'thinking')
      }
      const context = this.history.context(request.conversationId, request.id)
      let reply: string
      let result: HighlightReply | undefined
      let plan: HighlightPlan | null = null
      let outcome = 'no_target'
      if (request.highlight) {
        if (!image || !this.gateway.locate || !this.highlights) throw new AppProblem('highlight_unavailable', 'Screen highlighting is unavailable. Capture again or use Explain screen.')
        const snapshot = this.contexts?.forCapture(image.metadata.id)
        const candidates = snapshot ? locateElements(snapshot) : []
        result = await this.gateway.locate(key, model, context, request.controller.signal, image, candidates.length ? candidates : undefined)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        reply = result.explanation
        try {
          let anchor: ElementAnchor | undefined
          let rejected: AppProblem | undefined
          if (result.elementId) {
            // The id is only meaningful for the snapshot it was offered from: the
            // lookup refuses ids that snapshot never had, and any snapshot that
            // has since expired or been replaced by a newer generation.
            try {
              if (!snapshot || !this.contexts) throw new AppProblem('context_element', 'No element list was offered.')
              const element = this.contexts.element(snapshot.id, snapshot.generation, result.elementId)
              anchor = { frame: element.frame, pid: snapshot.app.pid, path: element.path, role: element.role }
            } catch (error) {
              if (!(error instanceof AppProblem)) throw error
              rejected = error.code === 'context_expired'
                ? new AppProblem('stale_element', 'No highlight: the view of the screen expired or was replaced. Capture again before asking where to click.')
                : new AppProblem('unknown_element', 'No highlight: the reply named an item that is not on the captured screen. Try a fresh capture.')
            }
          }
          if (anchor) {
            try { plan = this.highlights.plan(result, image.metadata, request.id, request.highlightRevision!, anchor) }
            // An element that is off this display can still be marked from the model's pixel box, if it gave one.
            catch (error) { if (!(error instanceof AppProblem) || error.code !== 'invalid_target' || !result.target) throw error }
          }
          if (!plan) {
            if (rejected && !result.target) throw rejected
            plan = this.highlights.plan(result, image.metadata, request.id, request.highlightRevision!)
          }
          outcome = plan ? 'prepared' : 'no_target'
        } catch (error) {
          if (!(error instanceof AppProblem)) throw error
          outcome = error.code
          reply += '\n\n' + error.message
        }
      } else if (request.simplifyScreen) {
        reply = await this.simplifyFront(request, key, model)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
      } else if (request.simplify && this.simplifier) {
        request.progress = request.simplify.url ? 'Opening and simplifying the page…' : 'Simplifying the demo page…'
        this.emit()
        const simplified = await this.simplifier.simplify(request.simplify, LOCAL_USER, { key, model }, request.controller.signal)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        this.history.activity(request.id, 'page_simplified', 'Simplified a page.', {})
        reply = describeResult(simplified)
      } else if (!image && !capture && this.gateway.route) {
        const route = await this.gateway.route(key, model, context, request.controller.signal)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        if (route.kind === 'reply') reply = route.text
        else if (route.kind === 'open_page') reply = await this.navigate(request, route.destination, route.query)
        else if (route.kind === 'simplify_page') {
          reply = await this.simplifyFront(request, key, model)
          if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        }
        else {
          const checked = validateFlight(route.flight)
          const parentTaskId = this.history.clarificationParent(request.conversationId)
          if (!checked.input) {
            reply = 'Before I search Alaska Airlines:\n' + checked.questions.map((question) => '• ' + question).join('\n')
            this.history.activity(request.id, 'flight_clarification', reply, { parentTaskId })
          } else {
            if (!this.browser) throw new AppProblem('browser_unavailable', 'Browser search is unavailable in this build.')
            clearTimeout(request.deadline)
            this.history.activity(request.id, 'flight_validated', 'Flight details validated. Starting an adults-only Alaska search.', { input: checked.input, parentTaskId })
            this.transition(request, 'browser')
            const outcome = await this.browser.run(request.id, checked.input, request.controller.signal,
              (type, detail, data) => {
                if (this.active?.id !== request.id || request.controller.signal.aborted) throw new AppProblem('stopped', 'Search stopped.')
                this.history.activity(request.id, type, redact(detail, [key]), data)
              }, (progress) => {
                if (this.active?.id !== request.id || request.controller.signal.aborted) return
                request.progress = progress
                this.emit()
              })
            if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
            reply = `Alaska Airlines search: ${outcome.status.replace('_', ' ')}.\n${outcome.detail}` +
              (outcome.finalUrl ? `\n${outcome.finalUrl}` : '') + '\nThe browser remains open for review. No ticket was selected or purchased.'
          }
        }
      } else reply = await this.gateway.reply(key, model, context, request.controller.signal, image)
      if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
      this.history.complete(request.id, redact(reply, [key]), result ? { captureId: image!.metadata.id, target: plan && !plan.anchor ? result.target : null, outcome, ...(plan ? { source: highlightSource(plan) } : {}) } : undefined)
      clearTimeout(request.deadline)
      this.active = null
      if (plan) this.highlights?.present(plan)
      this.emit()
    } catch (error) {
      if (this.disposed || this.active?.id !== request.id) return
      if (error instanceof AppProblem && error.code === 'storage') {
        clearTimeout(request.deadline)
        request.controller.abort()
        this.active = null
        try { if (request.stage === 'browser') this.history.finish(request.id, 'failed', 'History storage failed; browser execution stopped.') } catch { /* Storage may remain unavailable. */ }
        this.blockStorage()
        return
      }
      this.finish(request, 'failed', publicProblem(error).message)
    } finally {
      // A canceled native capture can restore the windows after Stop. Publish once
      // it settles so the gesture conversation can be opened without spoiling capture.
      if (capture && !this.disposed) this.emit()
    }
  }

  /** Reads the page in front, simplifies it and shows it. Nothing on the real page is clicked or typed into. */
  private async simplifyFront(request: RunningRequest, key: string, model: string): Promise<string> {
    if (!this.screenSimplifier) throw new AppProblem('simplifier_unavailable', 'Simplifying the page in front is unavailable in this build.')
    request.progress = 'Reading and simplifying the page in front…'
    this.emit()
    const simplified = await this.screenSimplifier.simplify(LOCAL_USER, { key, model }, request.controller.signal)
    if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return ''
    this.history.activity(request.id, 'page_simplified', 'Simplified the page in front.', {})
    return describeScreenResult(simplified)
  }

  /** Opens a curated destination in the user's browser; never a model-supplied URL. */
  private async navigate(request: RunningRequest, destinationId: string, query?: string): Promise<string> {
    let target
    try { target = resolveDestination(destinationId, query) }
    catch { throw new AppProblem('invalid_destination', 'I couldn’t find a safe page for that. Please say where you want to go another way.') }
    if (target.opensIn !== 'default') throw new AppProblem('navigation_unavailable', 'Opening pages in Triage’s own browser isn’t available yet.')
    if (!this.openPage) throw new AppProblem('navigation_unavailable', 'Opening pages is unavailable in this build.')
    this.history.activity(request.id, 'page_open', `Opening ${target.name}.`, { destination: target.id, url: target.url })
    try { await this.openPage(target.url) }
    catch { throw new AppProblem('navigation_failed', `I couldn’t open ${target.name}. Check that a web browser is installed and try again.`) }
    return `Opening ${target.name} in your web browser.
If you can’t find something on the page, ask “show me where…” and I’ll point to it.`
  }

  private blockStorage(): void {
    this.storageError = 'History could not be saved. New requests are paused; check disk space and restart Triage.'
    this.emit()
  }

  private finish(request: RunningRequest, status: 'failed' | 'stopped' | 'interrupted', message: string | null): void {
    clearTimeout(request.deadline)
    request.controller.abort()
    this.highlights?.clear()
    this.active = null
    try { this.history.finish(request.id, status, message) }
    catch { this.blockStorage() }
    this.emit()
  }

  stop(input: unknown): void {
    const id = validated(idSchema, input)
    if (!this.active) return
    if (this.active.id !== id) throw new AppProblem('not_active', 'That request is no longer active.')
    this.finish(this.active, 'stopped', this.active.stage === 'browser' ? 'Stopped by you. No further actions are authorized. A submitted search cannot be undone; unverified actions have an unknown outcome.' : 'Stopped by you. No later reply will be added.')
  }

  stopActive(): void { if (this.active) this.stop(this.active.id) }

  interrupt(message: string): void {
    this.connecting?.abort()
    this.highlights?.clear()
    if (this.active) this.finish(this.active, 'interrupted', message + ' No work will be replayed; unverified actions have an unknown outcome.')
  }

  async closeBrowser(): Promise<void> {
    this.idle()
    await this.browser?.close()
  }

  deleteConversation(input: unknown): void {
    if (this.disposed) throw new AppProblem('closed', 'Triage is closing.')
    const id = validated(idSchema, input)
    if (this.active?.conversationId === id) throw new AppProblem('busy', 'Stop this conversation’s request before deleting it.')
    try { this.history.delete(id) }
    catch (error) { this.blockStorage(); throw error }
    this.emit()
  }

  clearHistory(): void {
    this.idle()
    try { this.history.clear() }
    catch (error) { this.blockStorage(); throw error }
    this.emit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.connecting?.abort()
    try {
      if (this.active) this.finish(this.active, 'stopped', 'Stopped because Triage quit.')
      this.offHighlights?.()
      this.offLost?.()
      this.highlights?.clear()
    } finally {
      this.credentials.dispose()
      this.history.close()
    }
  }
}
