import type { AssistantBridge } from './assistant-contracts'
import type { VoiceBridge } from './voice-contracts'
import type { TrustBridge } from './trust-contracts'
import type { SkillsBridge } from './skill-contracts'
import type { SpeechBridge } from './speech-contracts'
import type { RequestLogBridge } from './request-log-contracts'

export type CompanionMood = 'idle' | 'moving' | 'greeting' | 'thinking'

export interface DesktopPoint { x: number; y: number }

export interface DesktopState {
  visible: boolean
  chatOpen: boolean
  mood: CompanionMood
  shortcutAvailable: boolean
  /** The global talk shortcut as key labels (e.g. ["⌥", "space"]), or null if it could not be registered. */
  voiceShortcut: string[] | null
}

export const channels = {
  getState: 'desktop:get-state',
  state: 'desktop:state',
  toggleChat: 'desktop:toggle-chat',
  closeChat: 'desktop:close-chat',
  hide: 'desktop:hide',
  quit: 'desktop:quit',
  menu: 'desktop:menu',
  dragStart: 'desktop:drag-start',
  dragEnd: 'desktop:drag-end',
  pointer: 'desktop:pointer'
} as const

export interface DesktopBridge extends AssistantBridge, VoiceBridge, SpeechBridge, RequestLogBridge, TrustBridge, SkillsBridge {
  getState(): Promise<DesktopState>
  onState(listener: (state: DesktopState) => void): () => void
  toggleChat(): void
  closeChat(): void
  hide(): void
  quit(): void
  openMenu(): void
  beginDrag(point: DesktopPoint): void
  endDrag(allowClick?: boolean, point?: DesktopPoint): void
  setPointerInteractive(interactive: boolean): void
}
