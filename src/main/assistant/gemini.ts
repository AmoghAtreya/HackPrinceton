import { z } from 'zod'
import { routeSchema, type AssistantRoute } from '../../shared/flight-contracts.ts'
import type { ModelChoice } from '../../shared/assistant-contracts.ts'
import type { HighlightReply } from '../../shared/highlight-contracts.ts'
import type { ScreenImage } from '../../shared/screen-contracts.ts'
import { parseHighlightReply } from '../screen/coordinates.ts'
import { AppProblem } from './errors.ts'
import { SYSTEM, analysisSystemPrompt, routeSystemPrompt, screenSystemPrompt, screenUserText, type DialogueTurn, type ModelGateway } from './model.ts'
import type { ScreenAnalysisKind } from '../../shared/screen-analysis-contracts.ts'
import { modelSchema } from './schemas.ts'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Google AI Studio keys: the classic "AIza…" format or the newer "AQ.…" format.
 * Used to pick the provider for a key.
 */
export function isGeminiKey(key: string): boolean {
  const trimmed = key.trim()
  return /^AIza[0-9A-Za-z_-]{30,}$/.test(trimmed) || /^AQ\.[0-9A-Za-z_.-]{20,}$/.test(trimmed)
}

type Part = { text: string } | { inline_data: { mime_type: string; data: string } }

const generateResponse = z.object({
  candidates: z.array(z.object({
    content: z.object({ parts: z.array(z.object({ text: z.string().optional() }).passthrough()).optional() }).passthrough().optional(),
    finishReason: z.string().optional()
  }).passthrough()).optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).passthrough().optional()
}).passthrough()

const modelsResponse = z.object({
  models: z.array(z.object({
    name: z.string(), displayName: z.string().optional(),
    supportedGenerationMethods: z.array(z.string()).optional()
  }).passthrough()).optional()
}).passthrough()

export function geminiProblem(status: number | undefined, body = ''): AppProblem {
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(body)) return new AppProblem('authentication', 'Google rejected the Gemini API key. Reconnect in Settings.')
  if (status === 401) return new AppProblem('authentication', 'Google rejected this Gemini key. Check it was copied in full and created in Google AI Studio (aistudio.google.com/apikey) for the Gemini API.')
  if (status === 403) return new AppProblem('access_denied', 'This Gemini key does not have access to the requested model.')
  if (status === 404) return new AppProblem('model_unavailable', 'The selected Gemini model is unavailable. Reconnect or choose another model.')
  if (status === 429) return new AppProblem('rate_limit', 'Gemini is rate-limiting requests. Wait a moment before trying again.')
  if (status === 400) return new AppProblem('request_rejected', 'Gemini could not accept this request. Check your model and message length.')
  if (typeof status === 'number' && status >= 500) return new AppProblem('provider_unavailable', 'Gemini is temporarily unavailable. Please try again later.')
  return new AppProblem('connection', 'Could not reach Gemini. Check your internet connection and try again.')
}

/** Google Gemini over its REST API; same prompts and safety rules as the Claude gateway. */
export class GeminiGateway implements ModelGateway {
  private fetcher: typeof globalThis.fetch
  constructor(fetcher: typeof globalThis.fetch = globalThis.fetch) { this.fetcher = fetcher }

  private async call(key: string, path: string, signal: AbortSignal, body?: object, timeoutMs = 45000): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(BASE_URL + path, {
        method: body ? 'POST' : 'GET',
        // The key goes in a header, never in the URL.
        headers: { 'x-goog-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([signal, timeout])
      })
    } catch {
      if (signal.aborted) throw new AppProblem('stopped', 'Request stopped.')
      throw geminiProblem(undefined)
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) throw geminiProblem(response.status, text)
    try { return JSON.parse(text) }
    catch { throw new AppProblem('invalid_response', 'Gemini returned an unreadable reply. Please try again.') }
  }

  async models(key: string, signal: AbortSignal): Promise<ModelChoice[]> {
    const parsed = modelsResponse.safeParse(await this.call(key, '/models?pageSize=200', signal, undefined, 15000))
    if (!parsed.success) throw new AppProblem('invalid_response', 'Gemini returned an unreadable model list.')
    const models = (parsed.data.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
      .map((model) => ({ id: model.name.replace(/^models\//, ''), label: model.displayName || model.name }))
      .filter((model) => model.id.startsWith('gemini-') && modelSchema.safeParse(model.id).success && !/embedding|tts|image|audio|live/i.test(model.id))
    if (!models.length) throw new AppProblem('no_models', 'No Gemini text models are available for this key.')
    return models
  }

  private async generate(key: string, model: string, system: string, messages: DialogueTurn[], signal: AbortSignal,
    options: { image?: ScreenImage; json?: boolean } = {}): Promise<{ text: string; finishReason?: string }> {
    if (!modelSchema.safeParse(model).success) throw new AppProblem('model_unavailable', 'Choose a Gemini model in Settings.')
    const contents = messages.map((turn) => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] as Part[] }))
    if (options.image) {
      const last = contents.at(-1)
      if (!last || last.role !== 'user') throw new AppProblem('invalid_input', 'Screen explanations need a current question.')
      last.parts = [
        { inline_data: { mime_type: options.image.mediaType, data: options.image.data } },
        { text: screenUserText(messages.at(-1)!.content, options.image) }
      ]
    }
    const raw = await this.call(key, `/models/${encodeURIComponent(model)}:generateContent`, signal, {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 2048, ...(options.json ? { responseMimeType: 'application/json' } : {}) }
    })
    if (signal.aborted) throw new AppProblem('stopped', 'Reply stopped.')
    const parsed = generateResponse.safeParse(raw)
    if (!parsed.success) throw new AppProblem('invalid_response', 'Gemini returned an unreadable reply. Please try again.')
    if (parsed.data.promptFeedback?.blockReason) throw new AppProblem('request_rejected', 'Gemini declined this request. Try rephrasing it.')
    const candidate = parsed.data.candidates?.[0]
    const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim()
    if (!text || text.length > 32000) throw new AppProblem('invalid_response', 'No usable text reply was returned. Please try again.')
    return { text, finishReason: candidate?.finishReason }
  }

  async route(key: string, model: string, messages: DialogueTurn[], signal: AbortSignal): Promise<AssistantRoute> {
    const { text, finishReason } = await this.generate(key, model, routeSystemPrompt(), messages, signal, { json: true })
    if (finishReason && finishReason !== 'STOP') throw new AppProblem('invalid_route', 'The reply was incomplete. Please try again.')
    try { return routeSchema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))) }
    catch { throw new AppProblem('invalid_route', 'Gemini returned an invalid request. No browser action was started. Please rephrase.') }
  }

  async reply(key: string, model: string, messages: DialogueTurn[], signal: AbortSignal, image?: ScreenImage): Promise<string> {
    const { text, finishReason } = await this.generate(key, model, image ? screenSystemPrompt(image, false) : SYSTEM, messages, signal, { image })
    return finishReason === 'MAX_TOKENS' ? text + '\n\n[Reply reached the response length limit.]' : text
  }

  async analyze(key: string, model: string, kind: ScreenAnalysisKind, signal: AbortSignal, image: ScreenImage): Promise<string> {
    const question = kind === 'simplify' ? 'What can I do on this screen?' : 'Is this screen safe?'
    return (await this.generate(key, model, analysisSystemPrompt(kind), [{ role: 'user', content: question }], signal, { image, json: true })).text
  }

  async locate(key: string, model: string, messages: DialogueTurn[], signal: AbortSignal, image: ScreenImage): Promise<HighlightReply> {
    const { text, finishReason } = await this.generate(key, model, screenSystemPrompt(image, true), messages, signal, { image, json: true })
    if (finishReason && finishReason !== 'STOP') throw new AppProblem('invalid_target', 'The location response was incomplete. Try a fresh capture. No highlight was shown.')
    return parseHighlightReply(text, image.metadata)
  }
}

/** Sends each request to Claude or Gemini depending on which kind of key is connected. */
export class ProviderGateway implements ModelGateway {
  private claude: ModelGateway
  private gemini: ModelGateway
  constructor(claude: ModelGateway, gemini: ModelGateway) { this.claude = claude; this.gemini = gemini }

  private pick(key: string): ModelGateway { return isGeminiKey(key) ? this.gemini : this.claude }

  models(key: string, signal: AbortSignal) { return this.pick(key).models(key, signal) }
  reply(key: string, model: string, messages: DialogueTurn[], signal: AbortSignal, image?: ScreenImage) { return this.pick(key).reply(key, model, messages, signal, image) }
  route(key: string, model: string, messages: DialogueTurn[], signal: AbortSignal): Promise<AssistantRoute> {
    const gateway = this.pick(key)
    if (!gateway.route) throw new AppProblem('unsupported', 'This model provider cannot route requests.')
    return gateway.route(key, model, messages, signal)
  }
  analyze(key: string, model: string, kind: ScreenAnalysisKind, signal: AbortSignal, image: ScreenImage): Promise<string> {
    const gateway = this.pick(key)
    if (!gateway.analyze) throw new AppProblem('analysis_unavailable', 'This model provider cannot check the screen.')
    return gateway.analyze(key, model, kind, signal, image)
  }
  locate(key: string, model: string, messages: DialogueTurn[], signal: AbortSignal, image: ScreenImage): Promise<HighlightReply> {
    const gateway = this.pick(key)
    if (!gateway.locate) throw new AppProblem('highlight_unavailable', 'This model provider cannot point at controls.')
    return gateway.locate(key, model, messages, signal, image)
  }
}
