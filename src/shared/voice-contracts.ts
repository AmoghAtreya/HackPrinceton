import type { Result, SendReceipt } from './assistant-contracts'

export interface VoiceSettings {
  enabled: boolean
  microphoneId: string | null
  shortcut: string
  spokenReplies: false
  allowScreenCapture: false
}
export interface VoiceDevice { id: string; label: string }
export interface VoiceAvailability {
  microphone: 'not-determined' | 'denied' | 'authorized'
  speech: 'not-determined' | 'denied' | 'authorized'
  onDevice: boolean
  available: boolean
  devices: VoiceDevice[]
}
export interface VoiceContext {
  view: 'chat' | 'history' | 'settings'
  conversationId: string | null
  explicitSelection?: boolean
}
export interface VoiceShortcutState {
  chord: string | null
  status: 'unavailable' | 'registered' | 'denied' | 'conflict'
  notice: string
}
export interface VoiceState {
  activation?: 'manual' | 'hold'
  shortcut?: VoiceShortcutState
  conversationId: string | null
  conversationTitle: string
  receipt?: SendReceipt
  settings: VoiceSettings
  input: 'disabled' | 'ready' | 'starting' | 'listening' | 'finalizing' | 'suspended' | 'error'
  availability: VoiceAvailability | null
  sessionId: string | null
  provisional: string
  draft: string
  level: number
  notice: string
}
export const voiceChannels = {
  stop: 'voice:stop', context: 'voice:context', get: 'voice:get', save: 'voice:save', setup: 'voice:setup', start: 'voice:start',
  finish: 'voice:finish', cancel: 'voice:cancel', state: 'voice:state'
} as const
export interface VoiceBridge {
  stopVoice(): Promise<Result<VoiceState>>
  setVoiceContext(context: VoiceContext): Promise<Result<VoiceState>>
  getVoiceState(): Promise<Result<VoiceState>>
  saveVoiceSettings(settings: VoiceSettings): Promise<Result<VoiceState>>
  setupVoice(): Promise<Result<VoiceState>>
  startVoice(): Promise<Result<VoiceState>>
  finishVoice(sessionId: string): Promise<Result<VoiceState>>
  cancelVoice(sessionId: string): Promise<Result<VoiceState>>
  onVoiceState(listener: (state: VoiceState) => void): () => void
}
