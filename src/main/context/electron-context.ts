import { screen, systemPreferences } from 'electron'
import { createRequire } from 'node:module'
import type { FrameReading } from '../../shared/highlight-contracts'
import { readFrame } from './locate'
import type { ContextPort } from './service'

/** release/TriageContextSnapshot.node, built by npm run context:build. */
interface NativeContext {
  snapshot(): Promise<string> | string
  frameOf(pid: number, path: number[]): Promise<string>
}

export interface ElectronContext {
  port: ContextPort
  frameOf(pid: number, path: number[]): Promise<FrameReading>
}

/**
 * Loads the native accessibility module. Returns undefined when it is missing
 * or will not load, in which case highlights simply stay on the pixel-box path.
 */
export function electronContext(modulePath: string): ElectronContext | undefined {
  let native: NativeContext
  try {
    native = createRequire(modulePath)(modulePath)
    if (typeof native.snapshot !== 'function' || typeof native.frameOf !== 'function') return undefined
  } catch { return undefined }
  return {
    port: {
      // Never prompts: screen help must keep working without Accessibility access.
      permission: () => systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
      snapshot: () => native.snapshot(),
      displayIdFor: (frame, cursor) => String((cursor ? screen.getDisplayNearestPoint(cursor) : screen.getDisplayMatching(frame)).id)
    },
    frameOf: async (pid, path) => readFrame(await native.frameOf(pid, path))
  }
}
