import { randomUUID } from 'node:crypto'
import {
  axSnapshotSchema, CONTEXT_TTL_MS, SECURE_ROLE,
  type ContextElement, type ContextFrame, type ContextSnapshot
} from '../../shared/context-contracts.ts'
import type { ElementKind } from '../../shared/simplifier-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'

/** The native module (release/TriageContextSnapshot.node) plus the two things only Electron knows. */
export interface ContextPort {
  /** 'granted' when macOS Accessibility access is on; anything else is reported to the person. */
  permission(): string
  permissionHelp?(): string
  /** JSON text matching axSnapshotSchema. */
  snapshot(): Promise<string> | string
  /** The display that holds most of the window. */
  displayIdFor(frame: ContextFrame): string
}

const ROLE_KINDS: Record<string, ElementKind> = {
  AXButton: 'button',
  AXLink: 'link',
  AXTextField: 'input',
  [SECURE_ROLE]: 'input',
  AXTextArea: 'textarea',
  AXComboBox: 'select',
  // What Chrome and AppKit expose for a <select> / NSPopUpButton.
  AXPopUpButton: 'select',
  AXCheckBox: 'checkbox',
  AXRadioButton: 'radio',
  AXHeading: 'heading',
  AXStaticText: 'text'
}

/** Maps an accessibility role to the simplifier's ElementKind; null for roles with no equivalent. */
export function kindForRole(role: string): ElementKind | null {
  return Object.hasOwn(ROLE_KINDS, role) ? ROLE_KINDS[role] : null
}

export class ContextService {
  private port: ContextPort
  private now: () => number
  private snapshot: ContextSnapshot | null = null
  private generation = 0
  private pending = false
  private disposed = false
  private expires?: ReturnType<typeof setTimeout>
  constructor(port: ContextPort, now: () => number = Date.now) { this.port = port; this.now = now }

  /**
   * Snapshots the frontmost app's focused window. The result has no elements
   * when there is no focused window or the person switched apps mid-capture.
   */
  async capture(): Promise<ContextSnapshot> {
    if (this.disposed) throw new AppProblem('closed', 'Triage is closing.')
    if (this.pending) throw new AppProblem('busy', 'A context capture is already in progress.')
    this.clear()
    const permission = this.port.permission()
    if (permission !== 'granted') {
      const help = this.port.permissionHelp?.() ?? 'Allow Triage/Electron in macOS System Settings → Privacy & Security → Accessibility, then fully quit and reopen Triage.'
      throw new AppProblem('context_permission', 'macOS reports accessibility access as ' + permission + '. ' + help + ' Nothing on screen was read.')
    }
    const generation = this.generation
    this.pending = true
    try {
      const output = await this.port.snapshot()
      if (this.disposed) throw new AppProblem('closed', 'Triage closed during capture.')
      if (generation !== this.generation) throw new AppProblem('context_canceled', 'This context capture was discarded before it finished.')
      let raw: unknown
      try { raw = JSON.parse(output) } catch { raw = undefined }
      const parsed = axSnapshotSchema.safeParse(raw)
      // Never echo the payload or the validation issues: they can contain screen text.
      if (!parsed.success) throw new AppProblem('context_failed', 'The screen contents could not be read. Try again.')
      const elements: ContextElement[] = parsed.data.elements.map((element, index) => ({
        ...element, id: 'e' + index, kind: kindForRole(element.role)
      }))
      const snapshot: ContextSnapshot = {
        ...parsed.data, elements, id: randomUUID(), capturedAt: this.now(),
        displayId: this.port.displayIdFor(parsed.data.window.frame).slice(0, 64), generation
      }
      this.snapshot = snapshot
      this.expires = setTimeout(() => this.clear(), CONTEXT_TTL_MS)
      this.expires.unref?.()
      return snapshot
    } finally { this.pending = false }
  }

  /** The live snapshot, if `id` still names it and it is younger than 30 s. Does not consume it. */
  get(id: string): ContextSnapshot {
    const snapshot = this.snapshot
    if (!snapshot || snapshot.id !== id || snapshot.generation !== this.generation ||
        this.now() - snapshot.capturedAt > CONTEXT_TTL_MS) {
      throw new AppProblem('context_expired', 'That view of the screen expired or was replaced. Capture it again first.')
    }
    return snapshot
  }

  /**
   * Resolves an element id. "e<index>" is reused by every snapshot, so the
   * caller must also prove which snapshot and generation it is talking about.
   */
  element(snapshotId: string, generation: number, elementId: string): ContextElement {
    const snapshot = this.get(snapshotId)
    if (generation !== snapshot.generation) {
      throw new AppProblem('context_expired', 'That view of the screen expired or was replaced. Capture it again first.')
    }
    const element = snapshot.elements.find((candidate) => candidate.id === elementId)
    if (!element) throw new AppProblem('context_element', 'That item is not part of the captured screen.')
    return element
  }

  discard(id: string): void { if (this.snapshot?.id === id) this.clear() }

  clear(): void {
    this.generation++
    if (this.expires) clearTimeout(this.expires)
    this.expires = undefined
    this.snapshot = null
  }

  dispose(): void { this.disposed = true; this.clear() }
}
