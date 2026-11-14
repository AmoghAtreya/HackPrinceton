import type { ActivityEvent } from './flight-contracts'
import type { HighlightState } from './highlight-contracts'
import type { ScreenPreview } from './screen-contracts'
import type { ShakeSettings } from './shake-contracts'

export type RequestStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted'
export interface Problem { code: string; message: string }
export type Result<T> = { ok: true; value: T } | { ok: false; error: Problem }
export interface ModelChoice { id: string; label: string }
export interface PublicConfig {
  configured: boolean
  model: string
  models: ModelChoice[]
  keyStorage: 'none' | 'session' | 'encrypted' | 'locked'
  warning?: string
}
export interface ActiveRequest { id: string; conversationId: string; startedAt: number; stage?: 'capturing' | 'thinking' | 'browser'; progress?: string }
export interface AssistantState {
  config: PublicConfig
  active: ActiveRequest | null
  revision: number
  storageError?: string
  gestureRequest?: SendReceipt
  highlight?: HighlightState
}
export interface ConversationSummary { id: string; title: string; updatedAt: number }
export interface HistoryCursor { at: number; id: string }
export interface ConversationPage { items: ConversationSummary[]; next: HistoryCursor | null }
export interface SavedMessage {
  seq: number; id: string; taskId: string; role: 'user' | 'assistant'; content: string
  createdAt: number; status: RequestStatus; error: string | null
  source?: 'chat' | 'shake' | 'voice'
}
export interface ConversationDetail {
  conversation: ConversationSummary
  messages: SavedMessage[]
  activity?: ActivityEvent[]
  nextActivityBefore?: number | null
  nextBefore: number | null
}
export interface SendReceipt { taskId: string; conversationId: string }
export interface AssistantBridge {
  getShakeSettings(): Promise<Result<ShakeSettings>>
  saveShakeSettings(input: { enabled: boolean; instruction: string; mode?: 'explain' | 'highlight' }): Promise<Result<ShakeSettings>>
  getAssistantState(): Promise<Result<AssistantState>>
  onAssistantState(listener: (state: AssistantState) => void): () => void
  connectKey(input: { key: string; remember: boolean }): Promise<Result<PublicConfig>>
  removeKey(): Promise<Result<PublicConfig>>
  selectModel(model: string): Promise<Result<PublicConfig>>
  captureScreen(): Promise<Result<ScreenPreview>>
  discardScreen(): Promise<Result<void>>
  dismissHighlight(): Promise<Result<void>>
  sendMessage(input: { conversationId?: string; text: string; captureId?: string; mode?: 'explain' | 'highlight'; source?: 'chat' | 'voice' }): Promise<Result<SendReceipt>>
  closeBrowser(): Promise<Result<void>>
  stopRequest(taskId: string): Promise<Result<void>>
  listConversations(input: { before?: HistoryCursor }): Promise<Result<ConversationPage>>
  getConversation(input: { id: string; before?: number; beforeEvent?: number }): Promise<Result<ConversationDetail>>
  deleteConversation(id: string): Promise<Result<void>>
  clearHistory(): Promise<Result<void>>
}
export const assistantChannels = {
  getShake: 'assistant:get-shake', saveShake: 'assistant:save-shake',
  capture: 'assistant:capture', discard: 'assistant:discard', dismissHighlight: 'assistant:dismiss-highlight',
  state: 'assistant:state', getState: 'assistant:get-state', connect: 'assistant:connect',
  removeKey: 'assistant:remove-key', selectModel: 'assistant:select-model',
  closeBrowser: 'assistant:close-browser',
  send: 'assistant:send', stop: 'assistant:stop', list: 'assistant:list',
  detail: 'assistant:detail', delete: 'assistant:delete', clear: 'assistant:clear'
} as const
