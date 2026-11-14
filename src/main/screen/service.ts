import { randomUUID } from 'node:crypto'
import type { ScreenAccess, ScreenImage, ScreenPreview, ScreenCaptureOptions } from '../../shared/screen-contracts.ts'
import { AppProblem } from '../assistant/errors.ts'

export interface CapturePort {
  permission(): string
  permissionHelp?(): string
  capture(options?: ScreenCaptureOptions): Promise<Omit<ScreenImage, 'metadata'> & { metadata: Omit<ScreenImage['metadata'], 'id' | 'capturedAt'> }>
}

export class ScreenService implements ScreenAccess {
  private port: CapturePort
  private image: ScreenImage | null = null
  private generation = 0
  private pending = false
  private disposed = false
  private expires?: ReturnType<typeof setTimeout>
  constructor(port: CapturePort) { this.port = port }

  async capture(options?: ScreenCaptureOptions): Promise<ScreenPreview> {
    if (this.disposed) throw new AppProblem('closed', 'Triage is closing.')
    if (this.pending) throw new AppProblem('busy', 'A screen capture is already in progress.')
    this.clear()
    const permission = this.port.permission()
    if (permission !== 'granted') {
      const help = this.port.permissionHelp?.() ?? 'Allow Triage/Electron in macOS System Settings → Privacy & Security → Screen Recording, then fully quit and reopen Triage.'
      throw new AppProblem('screen_permission', 'macOS reports screen access as ' + permission + '. ' + help + ' No screen image was sent.')
    }
    const generation = this.generation
    this.pending = true
    try {
      const captured = await this.port.capture(options)
      if (this.disposed) throw new AppProblem('closed', 'Triage closed during capture.')
      if (generation !== this.generation) throw new AppProblem('capture_canceled', 'This capture was discarded before it finished.')
      if (!captured.data || captured.data.length > 5500000 ||
          captured.metadata.width < 1 || captured.metadata.height < 1) {
        throw new AppProblem('capture_failed', 'The screen image is empty or too large. Try capturing again.')
      }
      const image: ScreenImage = {
        ...captured, metadata: { ...captured.metadata, id: randomUUID(), capturedAt: Date.now() }
      }
      this.image = image
      this.expires = setTimeout(() => this.clear(), 60000)
      return { metadata: image.metadata, dataUrl: 'data:image/jpeg;base64,' + image.data }
    } finally { this.pending = false }
  }

  take(id: string): ScreenImage {
    const image = this.image
    if (!image || image.metadata.id !== id || Date.now() - image.metadata.capturedAt > 60000) {
      throw new AppProblem('capture_expired', 'That screen capture expired or was replaced. Capture a fresh screen before sending.')
    }
    this.clear()
    return image
  }

  discard(id: string): void { if (this.image?.metadata.id === id) this.clear() }

  clear(): void {
    this.generation++
    if (this.expires) clearTimeout(this.expires)
    this.expires = undefined
    this.image = null
  }

  dispose(): void { this.disposed = true; this.clear() }
}
