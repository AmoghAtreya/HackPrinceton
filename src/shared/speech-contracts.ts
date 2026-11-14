import type { Result } from './assistant-contracts'

/** Spoken replies (Amazon Polly). */

export const speechVoices = ['Joanna', 'Matthew', 'Ruth', 'Stephen'] as const
export type SpeechVoice = typeof speechVoices[number]

/** SSML prosody rate in percent: 80 = slower, 90 = relaxed, 100 = normal. */
export const speechRates = [80, 90, 100] as const
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
}

export const speechChannels = {
  getSettings: 'speech:get-settings',
  saveSettings: 'speech:save-settings',
  synthesize: 'speech:synthesize'
} as const
