/**
 * A short, soft two-note chime for the voice shortcut: rising when Triage starts
 * listening, falling when it stops. With the chat closed, this is how the user
 * knows the key press worked.
 */
let context: AudioContext | undefined

export function chime(kind: 'start' | 'stop'): void {
  try {
    context ??= new AudioContext()
    const audio = context
    void audio.resume()
    const notes = kind === 'start' ? [660, 880] : [880, 660]
    const now = audio.currentTime
    notes.forEach((frequency, index) => {
      const start = now + index * 0.09
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.08)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start(start)
      oscillator.stop(start + 0.09)
    })
  } catch { /* A missing chime must never block voice input. */ }
}
