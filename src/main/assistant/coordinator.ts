import type { BrowserRunner } from '../browser/supervisor.ts'
import { validateFlight } from '../browser/validation.ts'
import type { HighlightController, HighlightPlan } from '../screen/highlight.ts'
import type { HighlightReply } from '../../shared/highlight-contracts.ts'
import type { ShakeTrigger } from '../../shared/shake-contracts.ts'
import type { ScreenAccess, ScreenImage, ScreenPreview } from '../../shared/screen-contracts.ts'
import type { ActiveRequest, AssistantState, SendReceipt } from '../../shared/assistant-contracts.ts'
import { Credentials } from './credentials.ts'
import { HistoryStore } from './history.ts'
import type { ModelGateway } from './model.ts'
import { AppProblem, publicProblem } from './errors.ts'
import { connectSchema, idSchema, modelSchema, sendSchema, validated } from './schemas.ts'
import { redact } from './redaction.ts'
import { describeResult, parseSimplifyCommand, type SimplifierService, type SimplifyCommand } from '../simplifier/service.ts'

interface RunningRequest extends ActiveRequest {
  highlight?: boolean
  highlightRevision?: number
  expectedDisplayId?: string
  controller: AbortController
  deadline?: ReturnType<typeof setTimeout>
  simplify?: SimplifyCommand
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
  private voiceInput: { id: string; controlOnly: boolean } | null = null
  private requestTimeout: number
  private highlights?: HighlightController
  private offHighlights?: () => void
  private gestureRequest?: SendReceipt
  private browser?: BrowserRunner
  private screens?: ScreenAccess
  private simplifier?: SimplifierService

  constructor(options: {
    history: HistoryStore; credentials: Credentials; gateway: ModelGateway
    changed: (state: AssistantState) => void; browser?: BrowserRunner; requestTimeout?: number; screens?: ScreenAccess; highlights?: HighlightController
    simplifier?: SimplifierService
  }) {
    this.simplifier = options.simplifier
    this.browser = options.browser
    this.highlights = options.highlights
    this.offHighlights = options.highlights?.onChange(() => this.emit())
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
    if (this.voiceInput) throw new AppProblem('busy', 'Finish or cancel voice input first. Your typed draft has not been sent.')
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

  reserveVoice(id: string): void {
    if (this.disposed) throw new AppProblem('closed', 'Triage is closing.')
    if (this.voiceInput) throw new AppProblem('busy', 'Finish or cancel voice input first.')
    this.voiceInput = { id, controlOnly: Boolean(this.active || this.connecting) }
  }

  releaseVoice(id: string): void {
    if (this.voiceInput?.id === id) this.voiceInput = null
  }

  sendVoice(id: string, text: string, conversationId?: string): SendReceipt {
    const reservation = this.voiceInput
    if (reservation?.id !== id) throw new AppProblem('stale_voice', 'This recording has ended.')
    // Synchronous transfer: there is no await between releasing input and owning a task.
    this.voiceInput = null
    if (reservation.controlOnly) throw new AppProblem('busy', 'I’m still working; stop this task first. Start a fresh recording for another request.')
    return this.accept({ text, ...(conversationId ? { conversationId } : {}) }, 'voice')
  }

  send(input: unknown): SendReceipt { return this.accept(input, 'chat') }

  private accept(input: unknown, source: 'chat' | 'voice'): SendReceipt {
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
    return this.start(request, key, model, image, undefined, undefined, source, simplify ?? undefined)
  }

  shake(trigger: ShakeTrigger, instruction: string, capture: () => Promise<ScreenPreview>, mode: 'explain' | 'highlight' = 'explain'): SendReceipt | null {
    if (this.disposed || this.storageError) return null
    let key = ''
    let problem: string | undefined
    try { key = this.credentials.getKey() } catch (error) { problem = publicProblem(error).message }
    const model = this.credentials.snapshot().model
    if (this.active || this.connecting || this.voiceInput) problem = 'Shake skipped: finish or stop the current request first. No screenshot was taken.'
    if (!model && !problem) problem = 'Connect your key and choose an available model in Settings.'
    const gesture = { ...trigger, point: { ...trigger.point }, instruction: redact(instruction, [key]) }
    if (problem) {
      try {
        const receipt = this.history.begin('[Shake to Help] ' + gesture.instruction, model || 'not-configured', undefined, undefined, gesture)
        this.history.finish(receipt.taskId, 'failed', problem)
        if (!this.active && !this.connecting && !this.voiceInput) this.gestureRequest = receipt
        this.emit()
        return receipt
      } catch { this.blockStorage(); return null }
    }
    return this.start({ text: gesture.instruction, mode }, key, model, undefined, gesture, capture)
  }

  private start(request: { text: string; conversationId?: string; mode?: 'explain' | 'highlight' }, key: string, model: string,
    image?: ScreenImage, gesture?: ShakeTrigger & { instruction: string }, capture?: () => Promise<ScreenPreview>, source: 'chat' | 'voice' = 'chat',
    simplify?: SimplifyCommand): SendReceipt {
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
      ...(simplify ? { simplify } : {})
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
        result = await this.gateway.locate(key, model, context, request.controller.signal, image)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        reply = result.explanation
        try {
          plan = this.highlights.plan(result, image.metadata, request.id, request.highlightRevision!)
          outcome = plan ? 'prepared' : 'no_target'
        } catch (error) {
          if (!(error instanceof AppProblem)) throw error
          outcome = error.code
          reply += '\n\n' + error.message
        }
      } else if (request.simplify && this.simplifier) {
        request.progress = request.simplify.url ? 'Opening and simplifying the page…' : 'Simplifying the demo page…'
        this.emit()
        const simplified = await this.simplifier.simplify(request.simplify, 'local-user', { key, model }, request.controller.signal)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        this.history.activity(request.id, 'page_simplified', 'Simplified a page.', {})
        reply = describeResult(simplified)
      } else if (!image && !capture && this.gateway.route) {
        const route = await this.gateway.route(key, model, context, request.controller.signal)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        if (route.kind === 'reply') reply = route.text
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
      this.history.complete(request.id, redact(reply, [key]), result ? { captureId: image!.metadata.id, target: plan ? result.target : null, outcome } : undefined)
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
    if (this.voiceInput) throw new AppProblem('busy', 'Finish or cancel voice input before deleting history.')
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
    this.voiceInput = null
    this.connecting?.abort()
    try {
      if (this.active) this.finish(this.active, 'stopped', 'Stopped because Triage quit.')
      this.offHighlights?.()
      this.highlights?.clear()
    } finally {
      this.credentials.dispose()
      this.history.close()
    }
  }
}
