export type VoiceControl = 'stop' | 'stop-speaking' | 'disable'

export function voiceControl(text: string): VoiceControl | null {
  const command = text.trim().toLowerCase().replace(/[.!?,;:]+$/u, '').trim()
  if (command === 'stop' || command === 'cancel') return 'stop'
  if (command === 'stop speaking') return 'stop-speaking'
  if (command === 'turn off voice') return 'disable'
  return null
}

// Phase 10 has no voice screen-consent path. Fail closed for explicit visual
// instructions and ambiguous deictic questions; never infer capture permission.
export function needsVoiceScreen(text: string): boolean {
  return /\b(screen|screenshot|display|on[- ]screen)\b/i.test(text) ||
    /\b(this|current|my)\s+(window|page|app|button|control)\b/i.test(text) ||
    /\b(show me where|where (?:is|are) (?:the|that|this)|highlight|look at|what (?:is|are|does) (?:that|this|these|those))\b/i.test(text)
}
