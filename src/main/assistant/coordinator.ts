import type { BrowserRunner } from '../browser/supervisor.ts'
import { validateFlight } from '../browser/validation.ts'
import { HIGHLIGHT_LOST_MESSAGE, highlightSource, type HighlightController, type HighlightPlan } from '../screen/highlight.ts'
import type { ElementAnchor, HighlightReply } from '../../shared/highlight-contracts.ts'
import { GUIDE_CLICK_DELAY_MS, guideGoal, isNextStep } from '../../shared/guide-contracts.ts'
import { GuideSession } from './guide.ts'
import { locateElements } from '../context/locate.ts'
import type { ContextLookup } from '../context/paired-capture.ts'
import type { ShakeTrigger } from '../../shared/shake-contracts.ts'
import type { ScreenAccess, ScreenImage, ScreenPreview } from '../../shared/screen-contracts.ts'
import type { ActiveRequest, AssistantState, LearningSummary, MemorySnapshot, SendReceipt } from '../../shared/assistant-contracts.ts'
import { Credentials } from './credentials.ts'
import { HistoryStore } from './history.ts'
import type { ModelGateway } from './model.ts'
import { AppProblem, publicProblem } from './errors.ts'
import { analyzeSchema, connectSchema, fastModelSchema, idSchema, memoryIdSchema, modelSchema, rateSchema, sendSchema, validated } from './schemas.ts'
import { parseScreenAnalysis, type ScreenAnalysis } from '../../shared/screen-analysis-contracts.ts'
import { pickModel, type ModelPick, type RequestPurpose } from './tiers.ts'
import { redact } from './redaction.ts'
import { resolveDestination } from '../../shared/destinations.ts'
import type { RequestLog } from '../logging/request-log.ts'
import type { RequestOutcome, RequestRoute } from '../../shared/request-log-contracts.ts'
import type { TrustService } from '../trust/service.ts'
import type { SkillTutor } from '../skills/tutor.ts'
import { describeResult, parseSimplifyCommand, type SimplifierService, type SimplifyCommand } from '../simplifier/service.ts'
import { describeScreenResult, type ScreenSimplifier } from '../simplifier/screen.ts'
import { parseRememberCommand, type MemoryService, type MemoryStatement } from '../memory/service.ts'
import { parseRefillCommand, WHERE_WAS_I, type TaskRunner } from '../tasks/runner.ts'

/** Chat requests Triage handles itself, without asking a model to route them. */
type LocalCommand =
  | { kind: 'remember'; statement: MemoryStatement }
  | { kind: 'refill'; request: string }
  | { kind: 'resume'; answer: string }
  | { kind: 'where' }

// Triage is single-user on this Mac; the simplifier keys its learning by this ID.
const LOCAL_USER = 'local-user'

interface RunningRequest extends ActiveRequest {
  highlight?: boolean
  highlightRevision?: number
  expectedDisplayId?: string
  controller: AbortController
  deadline?: ReturnType<typeof setTimeout>
  /** The request as saved in history (known secrets removed), for the opt-in request log. */
  logText: string
  source: 'chat' | 'voice' | 'shake'
  route?: RequestRoute
  destination?: string
  simplify?: SimplifyCommand
  local?: LocalCommand
  /** Simplify the page frontmost in the user's own browser, without asking the model to route. */
  simplifyScreen?: boolean
  /** A screenshot was already requested for this request; a second one is never taken. */
  escalated?: boolean
  /** This request is the next step of the running guide, not a new question. */
  guideStep?: boolean
  /** A plain "help me …" request: start a guide towards this goal without asking the router. */
  guideGoal?: string
  /** The user's own words for this request, exactly as typed or spoken. */
  text: string
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
  private screenContext?: () => Promise<string | undefined>
  private captureScreen?: () => Promise<ScreenPreview>
  private trust?: Pick<TrustService, 'propose' | 'answer' | 'context'>
  private tutor?: Pick<SkillTutor, 'guidance' | 'asked' | 'locateGuidance' | 'pointed' | 'resolved'>
  private offClicked?: () => void
  /** Guided help in progress: one outlined step at a time towards the person's goal. */
  private guide: GuideSession | null = null
  private guideTimer?: ReturnType<typeof setTimeout>
  private guideClickDelay: number
  private contexts?: ContextLookup
  private gestureRequest?: SendReceipt
  private browser?: BrowserRunner
  private openPage?: (url: string) => Promise<void>
  private requestLog?: RequestLog
  private analyzing: AbortController | null = null
  private screens?: ScreenAccess
  private simplifier?: SimplifierService
  private memory?: MemoryService
  private tasks?: TaskRunner
  private screenSimplifier?: Pick<ScreenSimplifier, 'simplify' | 'forget'>

  constructor(options: {
    history: HistoryStore; credentials: Credentials; gateway: ModelGateway
    changed: (state: AssistantState) => void; browser?: BrowserRunner; requestTimeout?: number; screens?: ScreenAccess; highlights?: HighlightController
    simplifier?: SimplifierService
    memory?: MemoryService
    tasks?: TaskRunner
    /** Simplifies the page in front of the user from an accessibility snapshot. */
    screenSimplifier?: Pick<ScreenSimplifier, 'simplify' | 'forget'>
    /** Accessibility snapshots paired with screenshots; without it highlights are pixel boxes only. */
    contexts?: ContextLookup
    /** A <screen_context> text block describing what is frontmost right now, for plain chat. */
    screenContext?: () => Promise<string | undefined>
    /** Takes a redacted screenshot when the model says the text snapshot is not enough. */
    captureScreen?: () => Promise<ScreenPreview>
    /** The local list of people and organizations the user really deals with. */
    trust?: Pick<TrustService, 'propose' | 'answer' | 'context'>
    /** What the person already knows how to do; shapes how-to answers and learns from what they do. */
    tutor?: Pick<SkillTutor, 'guidance' | 'asked' | 'locateGuidance' | 'pointed' | 'resolved'>
    /** Opens a vetted https URL in the user's own browser. */
    openPage?: (url: string) => Promise<void>
    /** Receives every finished request; it decides (consent) whether to keep it. */
    requestLog?: RequestLog
    /** How long after a click on the outlined control the next guide step starts. */
    guideClickDelay?: number
  }) {
    this.guideClickDelay = options.guideClickDelay ?? GUIDE_CLICK_DELAY_MS
    this.simplifier = options.simplifier
    this.memory = options.memory
    this.tasks = options.tasks
    this.screenContext = options.screenContext
    this.captureScreen = options.captureScreen
    this.trust = options.trust
    this.tutor = options.tutor
    // Clicking the outlined control first try is evidence the person can do it; losing it is evidence they could not.
    this.offClicked = options.highlights?.onClicked((state) => {
      this.tutor?.resolved(state.taskId, true)
      // In a guide, clicking the outlined control is "done, what next?": look again once the screen has changed.
      if (!this.liveGuide()?.current(state.taskId)) return
      clearTimeout(this.guideTimer)
      this.guideTimer = setTimeout(() => {
        try { this.guideNext() } catch { /* Busy or over: "next" and the Next step button still work. */ }
      }, this.guideClickDelay)
      this.guideTimer.unref?.()
    })
    this.screenSimplifier = options.screenSimplifier
    this.browser = options.browser
    this.openPage = options.openPage
    this.requestLog = options.requestLog
    this.highlights = options.highlights
    this.offHighlights = options.highlights?.onChange(() => this.emit())
    this.contexts = options.contexts
    this.offLost = options.highlights?.onLost((state) => {
      if (this.disposed) return
      this.tutor?.resolved(state.taskId, false)
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
      ...(this.highlights?.snapshot() ? { highlight: this.highlights.snapshot()! } : {}),
      ...(this.liveGuide() ? { guide: this.guide!.snapshot() } : {})
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

  setFastModel(input: unknown) {
    this.idle()
    const config = this.credentials.setFastModel(validated(fastModelSchema, input))
    this.emit()
    return config
  }

  clearHighlight(): void { this.highlights?.clear() }

  /** The running guide, unless it has sat untouched for too long. */
  private liveGuide(): GuideSession | null {
    if (this.guide?.expired) this.endGuide()
    return this.guide
  }

  private endGuide(): void {
    clearTimeout(this.guideTimer)
    this.guide = null
  }

  /** "Next", the Next step button, or a click on the outlined control: look at the screen again and show the next step. */
  guideNext(): SendReceipt {
    const guide = this.liveGuide()
    if (!guide) throw new AppProblem('no_guide', 'I’m not guiding you through anything right now. Ask me for help with something to start.')
    this.idle()
    if (this.storageError) throw new AppProblem('storage', this.storageError)
    const key = this.credentials.getKey()
    const model = this.credentials.snapshot().model
    if (!model) throw new AppProblem('missing_model', 'Connect your key and choose an available model in Settings.')
    return this.start({ text: 'Next step', conversationId: guide.conversationId }, key, model, undefined, undefined, undefined,
      guide.spoken ? 'voice' : 'chat', undefined, false, undefined, true)
  }

  /** Stops guiding and removes the outline. A request that is already running is left to finish. */
  guideStop(): void {
    if (!this.guide) return
    this.endGuide()
    this.highlights?.clear()
    this.emit()
  }

  /**
   * "What can I do here?" or "Is this safe?" for a captured screenshot. Returns
   * structured help for a card in the chat window; nothing is saved to history.
   */
  async analyzeScreen(input: unknown): Promise<ScreenAnalysis> {
    const { captureId, kind, source } = validated(analyzeSchema, input)
    this.idle()
    if (this.analyzing) throw new AppProblem('busy', 'I’m still looking at your screen. One moment.')
    if (!this.gateway.analyze || !this.screens) throw new AppProblem('analysis_unavailable', 'Checking the screen is unavailable in this build.')
    const key = this.credentials.getKey()
    const config = this.credentials.snapshot()
    if (!config.model) throw new AppProblem('missing_model', 'Connect your key and choose an available model in Settings.')
    // Reading a screenshot is a vision request, so it follows the same model tier as Explain screen.
    const model = pickModel('vision', config.models, config.model, config.fastModel).model
    const image = this.screens.take(captureId)
    const controller = new AbortController()
    this.analyzing = controller
    const startedAt = Date.now()
    const deadline = setTimeout(() => controller.abort(), this.requestTimeout)
    try {
      const text = await this.gateway.analyze(key, model, kind, controller.signal, image)
      if (this.disposed) throw new AppProblem('closed', 'Triage is closing.')
      const analysis = parseScreenAnalysis(kind, text)
      if (!analysis) throw new AppProblem('invalid_analysis', kind === 'simplify' ? 'I couldn’t simplify this screen. Please try again.' : 'I couldn’t check this screen. Please try again.')
      try {
        this.requestLog?.record({ at: Date.now(), source: source ?? 'chat', text: kind === 'simplify' ? '[Simplify screen]' : '[Is this safe?]', route: kind,
          outcome: 'completed', latencyMs: Date.now() - startedAt,
          reply: redact(analysis.kind === 'simplify' ? analysis.view.summary : `${analysis.check.verdict}: ${analysis.check.headline}`, [key]) })
      } catch { /* Logging must never break a request. */ }
      return analysis
    } catch (error) {
      if (controller.signal.aborted && !this.disposed) throw new AppProblem('timeout', 'Looking at the screen took too long. Please try again.')
      throw error
    } finally {
      clearTimeout(deadline)
      this.analyzing = null
    }
  }

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
    // While guiding, a bare "next" or "done" typed in that conversation means the next step.
    const guide = this.liveGuide()
    if (!image && guide && request.conversationId === guide.conversationId && isNextStep(request.text))
      return this.start(request, key, model, undefined, undefined, undefined, request.source ?? 'chat', undefined, false, undefined, true)
    const simplify = !image && this.simplifier ? parseSimplifyCommand(request.text) : null
    const local = !image && !simplify ? this.localCommand(request.text, request.conversationId) : undefined
    const goal = !image && !simplify && !local ? guideGoal(request.text) : null
    return this.start({ ...request, ...(goal ? { guideGoal: goal } : {}) }, key, model, image, undefined, undefined, request.source ?? 'chat', simplify ?? undefined, false, local)
  }

  /**
   * A paused task in this conversation takes the next message as its answer
   * (slash commands excepted). Otherwise: "where was I?", refill requests and
   * "remember …" are recognised by rules here.
   */
  private localCommand(text: string, conversationId?: string): LocalCommand | undefined {
    const trimmed = text.trim()
    if (this.tasks) {
      if (conversationId && !trimmed.startsWith('/') && this.tasks.waiting(conversationId)) return { kind: 'resume', answer: trimmed }
      if (WHERE_WAS_I.test(trimmed)) return { kind: 'where' }
      const refill = parseRefillCommand(trimmed)
      if (refill) return { kind: 'refill', request: refill }
    }
    const statement = this.memory ? parseRememberCommand(trimmed) : null
    return statement ? { kind: 'remember', statement } : undefined
  }

  memorySnapshot(): MemorySnapshot {
    return {
      tasks: (this.tasks?.list() ?? []).map(({ createdAt: _created, ...task }) => task),
      memories: (this.memory?.list() ?? []).map((item) => ({ id: item.id, kind: item.kind, text: item.text }))
    }
  }

  async forgetMemory(input: unknown): Promise<MemorySnapshot> {
    const id = validated(memoryIdSchema, input)
    if (!this.memory) throw new AppProblem('memory_unavailable', 'Memory is unavailable in this build.')
    await this.memory.forget(id)
    this.emit()
    return this.memorySnapshot()
  }

  private async runLocal(request: RunningRequest, command: LocalCommand): Promise<string> {
    const onStep = (step: string) => {
      if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
      this.history.activity(request.id, 'task_step', step, {})
      request.progress = step
      this.emit()
    }
    switch (command.kind) {
      case 'remember': {
        const { statement } = command
        await this.memory!.remember(statement.kind, statement.text, { ...(statement.key ? { key: statement.key } : {}), ...(statement.extra ?? {}) })
        this.history.activity(request.id, 'memory_saved', 'Saved to memory on this Mac.', {})
        return `Got it. I'll remember: ${statement.text}.\nYou can see or remove what I remember in History.`
      }
      case 'where': return this.tasks!.whereWasI(request.conversationId)
      case 'refill': {
        // Multi-step tasks wait on the person between turns; the per-request
        // deadline would otherwise cut off a slow first browser launch.
        clearTimeout(request.deadline)
        request.progress = 'Starting your refill…'
        this.emit()
        return (await this.tasks!.start(request.conversationId, command.request, onStep)).reply
      }
      case 'resume':
        clearTimeout(request.deadline)
        return (await this.tasks!.resume(request.conversationId, command.answer, onStep)).reply
    }
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

  private start(request: { text: string; conversationId?: string; mode?: 'explain' | 'highlight'; guideGoal?: string }, key: string, model: string,
    image?: ScreenImage, gesture?: ShakeTrigger & { instruction: string }, capture?: () => Promise<ScreenPreview>, source: 'chat' | 'voice' = 'chat',
    simplify?: SimplifyCommand, simplifyScreen = false, local?: LocalCommand, guideStep = false): SendReceipt {
    // Anything other than "next" is a new request, so a running guide is over.
    if (!guideStep) this.endGuide()
    clearTimeout(this.guideTimer)
    this.highlights?.clear()
    let receipt: SendReceipt
    const logText = redact((gesture ? '[Shake to Help] ' : request.mode === 'highlight' ? '[Show me where] ' : image ? '[Screen explanation] ' : '') + request.text, [key])
    try {
      receipt = this.history.begin(logText, model, request.conversationId, image?.metadata, gesture, source)
      this.history.activity(receipt.taskId, 'request_status', capture ? 'Capturing screen…' : 'Thinking…', { stage: capture ? 'capturing' : 'thinking' })
    }
    catch (error) {
      if (error instanceof AppProblem && error.code === 'storage') this.blockStorage()
      throw error
    }
    const active: RunningRequest = {
      id: receipt.taskId, conversationId: receipt.conversationId, text: request.text,
      startedAt: Date.now(), stage: capture ? 'capturing' : 'thinking', controller: new AbortController(),
      expectedDisplayId: gesture?.displayId, highlight: request.mode === 'highlight', highlightRevision: this.highlights?.revision,
      logText, source: gesture ? 'shake' : source,
      ...(simplify ? { simplify } : {}), ...(simplifyScreen ? { simplifyScreen } : {}),
      ...(local ? { local } : {}), ...(guideStep ? { guideStep } : {}), ...(request.guideGoal ? { guideGoal: request.guideGoal } : {})
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
      const config = this.credentials.snapshot()
      // `model` is the person's selected model; each call goes to the tier its purpose needs.
      const pick = (purpose: RequestPurpose) => pickModel(purpose, config.models, model, config.fastModel)
      let used = pick(image ? 'vision' : 'reply')
      let escalated = false
      let local = false
      const plainChat = !image && !capture && !request.highlight && !request.simplify && !request.simplifyScreen && !request.guideStep && !request.guideGoal
      // A yes/no to "Should I remember this?" is read by code, not by the model.
      const answered = plainChat ? this.trust?.answer(request.conversationId, request.text) ?? null : null
      // Facts from the user's own list: sent as trusted context, apart from anything read off the screen.
      const trusted = this.trust?.context(request.text)
      let reply = ''
      let result: HighlightReply | undefined
      let plan: HighlightPlan | null = null
      let outcome = 'no_target'
      // One guide step: sets the same locals as "Show me where". False when the request was stopped meanwhile.
      const guideStep = async (): Promise<boolean> => {
        const step = await this.runGuideStep(request, key, pick('locate'), context)
        if (!step) return false
        reply = step.reply; result = step.result; plan = step.plan; outcome = step.outcome
        if (step.image) image = step.image
        used = step.used
        return true
      }
      if (request.guideStep) {
        if (!await guideStep()) return
      } else if (request.guideGoal) {
        this.guide = new GuideSession({ conversationId: request.conversationId, goal: request.guideGoal, spoken: request.source === 'voice' })
        if (!await guideStep()) return
      } else if (request.highlight) {
        request.route = 'highlight'
        if (!image || !this.gateway.locate || !this.highlights) throw new AppProblem('highlight_unavailable', 'Screen highlighting is unavailable. Capture again or use Explain screen.')
        const snapshot = this.contexts?.forCapture(image.metadata.id)
        const candidates = snapshot ? locateElements(snapshot) : []
        used = pick('locate')
        result = await this.gateway.locate(key, used.model, context, request.controller.signal, image, candidates.length ? candidates : undefined,
          this.tutor?.locateGuidance(LOCAL_USER, request.conversationId))
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        reply = result.explanation
        const pointed = this.pointAt(request, image, result, snapshot)
        plan = pointed.plan
        outcome = pointed.outcome
        if (pointed.note) reply += '\n\n' + pointed.note
      } else if (request.local) {
        reply = await this.runLocal(request, request.local)
      } else if (request.simplifyScreen) {
        used = pick('simplify')
        reply = await this.simplifyFront(request, key, used.model)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
      } else if (request.simplify && this.simplifier) {
        request.progress = request.simplify.url ? 'Opening and simplifying the page…' : 'Simplifying the demo page…'
        this.emit()
        used = pick('simplify')
        const simplified = await this.simplifier.simplify(request.simplify, LOCAL_USER, { key, model: used.model }, request.controller.signal)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        this.history.activity(request.id, 'page_simplified', 'Simplified a page.', {})
        reply = describeResult(simplified)
      } else if (answered !== null) {
        reply = answered
        local = true
      } else if (!image && !capture && this.gateway.route) {
        // Awaited only when there is something to read, so dispatch stays immediate otherwise.
        const screenContext = this.screenContext ? await this.readScreenContext() : undefined
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        used = pick('route')
        const route = await this.gateway.route(key, used.model, context, request.controller.signal, screenContext, trusted)
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        request.route = route.kind
        if (route.kind === 'open_page') request.destination = route.destination
        if (route.kind === 'reply') reply = route.text
        else if (route.kind === 'open_page') reply = await this.navigate(request, route.destination, route.query)
        else if (route.kind === 'simplify_page') {
          used = pick('simplify')
          reply = await this.simplifyFront(request, key, used.model)
          if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        }
        else if (route.kind === 'remember_contact') {
          // Only a suggestion from the model. It becomes a question only if the user's own words back it, and is saved only on "yes".
          reply = this.trust?.propose(request.conversationId, route.contact, request.text) ??
            'I can only save contact details that you tell me yourself. Say the name with their email, phone number or website, or add them in Settings.'
        }
        else if (route.kind === 'how_to') {
          // The plan is made before this question counts as evidence, from catalogue skills only.
          const guidance = this.tutor?.guidance(LOCAL_USER, route.skills)
          this.tutor?.asked(LOCAL_USER, request.conversationId, route.skills)
          used = pick('reply')
          reply = await this.gateway.reply(key, used.model, context, request.controller.signal, undefined, screenContext,
            [trusted, guidance].filter(Boolean).join('\n\n') || undefined)
          if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        }
        else if (route.kind === 'guide') {
          this.guide = new GuideSession({ conversationId: request.conversationId, goal: route.goal, spoken: request.source === 'voice' })
          if (!await guideStep()) return
        }
        else if (route.kind === 'needs_screenshot') {
          const vision = pick('vision')
          const answer = await this.escalate(request, key, vision.model, context, screenContext, trusted)
          if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
          reply = answer.reply
          if (answer.sent) { used = vision; escalated = true }
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
      } else {
        request.route = image ? 'explain' : 'reply'
        used = pick(image ? 'vision' : 'reply')
        const screenContext = image || !this.screenContext ? undefined : await this.readScreenContext()
        if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
        reply = await this.gateway.reply(key, used.model, context, request.controller.signal, image, screenContext, trusted)
      }
      if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) return
      const savedReply = redact(reply, [key])
      this.history.complete(request.id, savedReply, result ? { captureId: image!.metadata.id, target: plan && !plan.anchor ? result.target : null, outcome, ...(plan ? { source: highlightSource(plan) } : {}) } : undefined,
        local ? undefined : { tier: used.tier, model: used.model, screenshotEscalation: escalated })
      clearTimeout(request.deadline)
      this.active = null
      this.report(request, 'completed', savedReply)
      if (plan && this.highlights?.present(plan)) this.tutor?.pointed(LOCAL_USER, request.conversationId, request.id)
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

  /**
   * Turns the model's answer into a highlight that is ready to show: the listed
   * element's real frame when it named one, otherwise its pixel box. A problem
   * placing it comes back as a note for the reply, never as a failed request.
   */
  private pointAt(request: RunningRequest, image: ScreenImage, result: HighlightReply, snapshot: ReturnType<ContextLookup['forCapture']>):
    { plan: HighlightPlan | null; outcome: string; note?: string } {
    let plan: HighlightPlan | null = null
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
        try { plan = this.highlights!.plan(result, image.metadata, request.id, request.highlightRevision!, anchor) }
        // An element that is off this display can still be marked from the model's pixel box, if it gave one.
        catch (error) { if (!(error instanceof AppProblem) || error.code !== 'invalid_target' || !result.target) throw error }
      }
      if (!plan) {
        if (rejected && !result.target) throw rejected
        plan = this.highlights!.plan(result, image.metadata, request.id, request.highlightRevision!)
      }
      return { plan, outcome: plan ? 'prepared' : 'no_target' }
    } catch (error) {
      if (!(error instanceof AppProblem)) throw error
      return { plan: null, outcome: error.code, note: error.message }
    }
  }

  /**
   * One step of guided help: take a fresh screenshot (private fields blacked
   * out), ask the model for only the next thing to do towards the goal, and
   * prepare an outline around that control. Returns null if the request was
   * stopped meanwhile. A step that cannot be shown keeps the guide open so
   * "next" tries again.
   */
  private async runGuideStep(request: RunningRequest, key: string, used: ModelPick, context: Array<{ role: 'user' | 'assistant'; content: string }>):
    Promise<{ reply: string; result?: HighlightReply; plan: HighlightPlan | null; outcome: string; image?: ScreenImage; used: ModelPick } | null> {
    const guide = this.guide
    if (!guide) throw new AppProblem('no_guide', 'I’m not guiding you through anything right now. Ask me for help with something to start.')
    request.route = 'guide'
    if (!this.captureScreen || !this.screens || !this.gateway.locate || !this.highlights) {
      this.endGuide()
      throw new AppProblem('highlight_unavailable', 'I can’t point at things on the screen in this build. Use Capture screen and ask where to click.')
    }
    guide.attempted(request.id)
    request.progress = 'Looking at your screen…'
    this.emit()
    const preview = await this.captureScreen()
    const stopped = () => this.disposed || this.active?.id !== request.id || request.controller.signal.aborted
    if (stopped()) { this.screens.discard?.(preview.metadata.id); return null }
    const image = this.screens.take(preview.metadata.id)
    // Nobody previews this screenshot, so it is only sent when the private-field check actually ran.
    if (image.metadata.redactedRegions === null)
      return { reply: 'I didn’t look at your screen, because I couldn’t hide passwords and card numbers first. Turn on Triage in System Settings → Privacy & Security → Accessibility, then say “next”.', plan: null, outcome: 'not_sent', used }
    this.history.attachCapture(request.id, image.metadata)
    this.history.activity(request.id, 'guide_step', 'Looked at the screen for the next step.', {})
    const snapshot = this.contexts?.forCapture(image.metadata.id)
    const candidates = snapshot ? locateElements(snapshot) : []
    const result = await this.gateway.locate(key, used.model, context, request.controller.signal, image, candidates.length ? candidates : undefined, undefined, guide.progress())
    if (stopped()) return null
    if (this.guide !== guide) return { reply: result.explanation, result: { ...result, target: null, elementId: undefined }, plan: null, outcome: 'guide_ended', image, used }
    if (result.done) {
      console.info(`Guide finished after ${guide.stepCount} steps.`)
      this.endGuide()
      return { reply: result.explanation, result, plan: null, outcome: 'guide_done', image, used }
    }
    const pointed = this.pointAt(request, image, result, snapshot)
    const step = guide.shown(request.id, result.explanation)
    // Shape only, never screen text: enough to see from the log whether boxes are being drawn.
    console.info(`Guide step ${step}: ${pointed.plan ? (pointed.plan.anchor ? 'outlined a listed control' : 'outlined a pixel box') : 'nothing to outline (' + pointed.outcome + ')'}; ${candidates.length} controls offered.`)
    let reply = `Step ${step}: ${result.explanation}`
    if (pointed.note) reply += '\n\n' + pointed.note.replace('Capture again before asking where to click.', 'Say “next” and I’ll look again.').replace('Try a fresh capture.', 'Say “next” and I’ll look again.')
    if (guide.exhausted) {
      this.endGuide()
      reply += '\n\nThat’s as many steps as I can guide in one go. Ask me again if you’d like to carry on.'
    }
    return { reply, result, plan: pointed.plan, outcome: pointed.outcome, image, used }
  }

  /** What is on screen right now, as text. Chat works without it, so any failure just means no block. */
  private async readScreenContext(): Promise<string | undefined> {
    if (!this.screenContext) return undefined
    try { return await this.screenContext() } catch { return undefined }
  }

  /**
   * The model said the text snapshot is not enough. Takes one screenshot (with
   * private fields blacked out by the capture path) and asks the same question
   * again with the image. The second call is a plain reply, which cannot route,
   * so a request can never escalate twice.
   */
  private async escalate(request: RunningRequest, key: string, model: string, context: Array<{ role: 'user' | 'assistant'; content: string }>,
    screenContext?: string, trusted?: string): Promise<{ reply: string; sent: boolean }> {
    if (request.escalated) throw new AppProblem('invalid_route', 'The reply could not be completed. Please try again.')
    request.escalated = true
    if (!this.captureScreen || !this.screens) return { sent: false, reply: 'I’d need to look at your screen to answer that. Use Capture screen below, then ask again.' }
    request.progress = 'Looking at your screen…'
    this.emit()
    const preview = await this.captureScreen()
    if (this.disposed || this.active?.id !== request.id || request.controller.signal.aborted) {
      this.screens.discard?.(preview.metadata.id)
      return { sent: false, reply: '' }
    }
    const image = this.screens.take(preview.metadata.id)
    // Nobody previews this screenshot, so it is only sent when the private-field check actually ran.
    if (image.metadata.redactedRegions === null) {
      return { sent: false, reply: 'I’d need to look at your screen to answer that, but I couldn’t check it for private fields, so I didn’t send it. Use Capture screen below to preview it and send it yourself.' }
    }
    this.history.attachCapture(request.id, image.metadata)
    this.history.activity(request.id, 'screenshot_escalation', 'Looked at the screen to answer.', {})
    return { sent: true, reply: await this.gateway.reply(key, model, context, request.controller.signal, image, screenContext, trusted) }
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
    this.report(request, status, undefined, message)
    this.emit()
  }

  private report(request: RunningRequest, outcome: RequestOutcome, reply?: string, error?: string | null): void {
    try {
      this.requestLog?.record({
        at: Date.now(), source: request.source, text: request.logText, outcome, latencyMs: Date.now() - request.startedAt,
        ...(request.route ? { route: request.route } : {}),
        ...(request.destination ? { destination: request.destination } : {}),
        ...(reply ? { reply } : {}),
        ...(error ? { error: redact(error) } : {})
      })
    } catch { /* Logging must never break a request. */ }
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
    if (this.guide?.conversationId === id) this.endGuide()
    if (this.active?.conversationId === id) throw new AppProblem('busy', 'Stop this conversation’s request before deleting it.')
    try { this.history.delete(id) }
    catch (error) { this.blockStorage(); throw error }
    this.emit()
  }

  clearHistory(): void {
    this.idle()
    this.endGuide()
    try { this.history.clear() }
    catch (error) { this.blockStorage(); throw error }
    this.emit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.connecting?.abort()
    this.analyzing?.abort()
    this.endGuide()
    try {
      if (this.active) this.finish(this.active, 'stopped', 'Stopped because Triage quit.')
      this.offHighlights?.()
      this.offLost?.()
      this.offClicked?.()
      this.highlights?.clear()
    } finally {
      this.credentials.dispose()
      this.history.close()
    }
  }
}
