import type { Result } from './assistant-contracts'

/** Spoken replies (Amazon Polly). */

export const speechVoices = ['Joanna', 'Matthew', 'Ruth', 'Stephen'] as const
export type SpeechVoice = typeof speechVoices[number]

/** SSML prosody rate in percent: 80 = slower, 90 = relaxed, 100 = normal, 115 = faster. */
export const speechRates = [80, 90, 100, 115] as const
export type SpeechRate = typeof speechRates[number]

/** When replies are read aloud: after voice or shake requests, after every request, or never. */
export type ReadAloud = 'voice' | 'always' | 'off'

export interface SpeechSettings {
  readAloud: ReadAloud
  rate: SpeechRate
  voice: SpeechVoice
  /**
   * Voice input: live captions stay on this Mac, then the finished recording is
   * sent to Google Gemini for a more accurate transcript. Falls back to the
   * on-device transcript without a Gemini key or internet.
   */
  geminiTranscription: boolean
  /** Read-only: whether a Gemini key is available for voice right now. */
  geminiKeyAvailable?: boolean
  /** Read-only: where that key comes from (the voice-only key, a Gemini chatbot key, or GEMINI_API_KEY). */
  geminiKeySource?: 'voice' | 'chatbot' | 'env' | null
  /** Read-only: state of the voice-only Gemini key. */
  geminiVoiceKey?: 'none' | 'session' | 'encrypted' | 'locked'
  warning?: string
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = { readAloud: 'voice', rate: 90, voice: 'Joanna', geminiTranscription: true }

/** Longest text the main process will synthesize in one call. */
export const SPEECH_MAX_CHARS = 1500

export interface SynthesizedSpeech {
  /** MP3 audio bytes. */
  audio: Uint8Array
  voice: SpeechVoice
}

export interface SpeechBridge {
  getSpeechSettings(): Promise<Result<SpeechSettings>>
  saveSpeechSettings(input: { readAloud: ReadAloud; rate: SpeechRate; voice: SpeechVoice; geminiTranscription?: boolean }): Promise<Result<SpeechSettings>>
  synthesizeSpeech(text: string): Promise<Result<SynthesizedSpeech>>
  /** Saves a Gemini key used only for voice transcription (the chatbot key is unchanged). */
  setGeminiVoiceKey(input: { key: string; remember: boolean }): Promise<Result<SpeechSettings>>
  removeGeminiVoiceKey(): Promise<Result<SpeechSettings>>
}

export const speechChannels = {
  getSettings: 'speech:get-settings',
  saveSettings: 'speech:save-settings',
  synthesize: 'speech:synthesize',
  setGeminiKey: 'speech:set-gemini-key',
  removeGeminiKey: 'speech:remove-gemini-key'
} as const
