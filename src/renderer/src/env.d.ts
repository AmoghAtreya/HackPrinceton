import type { OverlayBridge } from '../../shared/highlight-contracts'
import type { DesktopBridge } from '../../shared/contracts'

declare global {
  interface Window {
    triage: DesktopBridge
    triageOverlay?: OverlayBridge
  }
}

export {}
