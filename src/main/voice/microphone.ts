import { systemPreferences } from 'electron'
import { AppProblem } from '../assistant/errors.ts'

/** Asks macOS for microphone access once; later calls just check the saved answer. */
export async function ensureMicrophoneAccess(): Promise<void> {
  if (process.platform !== 'darwin') return
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return
  if (status === 'not-determined' && await systemPreferences.askForMediaAccess('microphone')) return
  throw new AppProblem('microphone_denied',
    'Triage cannot use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.')
}
