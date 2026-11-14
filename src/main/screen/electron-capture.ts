import { app, desktopCapturer, nativeImage, screen, systemPreferences } from 'electron'
import { resolve } from 'node:path'
import { captureSize } from './coordinates'
import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopWindows } from '../windows'
import { AppProblem } from '../assistant/errors'
import type { CapturePort } from './service'
import type { Rectangle } from '../../shared/highlight-contracts'
import { encodeRedacted } from './redact'

/**
 * `privateFields` runs alongside the screenshot, while Triage's own windows are
 * out of the way, with the cursor point the screenshot uses. It resolves to the
 * frames (global points) to black out, or null when the screen could not be
 * checked. The image is only ever encoded after those frames were overwritten.
 */
export function electronCapture(windows: DesktopWindows, beforeCapture?: () => void,
  privateFields?: (cursor: { x: number; y: number }) => Promise<Rectangle[] | null>): CapturePort {
  return {
    permission: () => systemPreferences.getMediaAccessStatus('screen'),
    permissionHelp: () => {
      const bundle = resolve(process.execPath, '../../..')
      return 'In System Settings → Privacy & Security → Screen Recording, use + to add this exact app: ' + bundle +
        '. Enable it, then choose Quit Triage from its menu and reopen it. Closing chat is not quitting.' +
        (app.isPackaged ? '' : ' This is a terminal-launched development build. If Electron is enabled but access still fails, open release/Triage.app directly from Finder instead; see README for preparation.')
    },
    capture: async (options) => {
      beforeCapture?.()
      const cursor = options?.cursor ?? screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      const restore = windows.hideForCapture(options?.focusAfterCapture ?? true)
      let timer: ReturnType<typeof setTimeout> | undefined
      let fields: Promise<Rectangle[] | null> | undefined
      try {
        await delay(250)
        fields = (privateFields?.({ x: cursor.x, y: cursor.y }) ?? Promise.resolve(null)).catch(() => null)
        const sources = await Promise.race([
          desktopCapturer.getSources({
            types: ['screen'], thumbnailSize: { width: 1280, height: 1280 }, fetchWindowIcons: false
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new AppProblem('capture_timeout', 'Screen capture timed out. Check screen permissions and try again.')), 10000)
          })
        ])
        const source = sources.find((item) => item.display_id === String(display.id))
        if (!source || source.thumbnail.isEmpty()) throw new AppProblem('capture_failed', 'No readable image was returned for this display. Check screen permission and restart Triage.')
        let image = source.thumbnail
        const actual = image.getSize()
        const size = captureSize(actual.width, actual.height)
        if (size.width !== actual.width || size.height !== actual.height) image = image.resize(size)
        const { width, height } = image.getSize()
        // Raw pixels only. Nothing is encoded until encodeRedacted has blacked out the private fields.
        const { bytes, redactedRegions } = encodeRedacted(image.toBitmap(), { bounds: display.bounds, width, height }, await fields,
          (bitmap) => nativeImage.createFromBitmap(Buffer.from(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength), { width, height }).toJPEG(80))
        if (bytes.length > 4000000) throw new AppProblem('capture_failed', 'The screen image is too large. Try a smaller display resolution.')
        return {
          data: bytes.toString('base64'), mediaType: 'image/jpeg' as const,
          metadata: {
            displayId: String(display.id), displayName: display.label || 'Current display',
            width, height, bounds: { ...display.bounds }, scaleFactor: display.scaleFactor, rotation: display.rotation, redactedRegions,
            cursor: {
              x: Math.max(0, Math.min(width - 1, (cursor.x - display.bounds.x) * width / display.bounds.width)),
              y: Math.max(0, Math.min(height - 1, (cursor.y - display.bounds.y) * height / display.bounds.height))
            }
          }
        }
      } catch (error) {
        if (error instanceof AppProblem) throw error
        throw new AppProblem('capture_failed', 'Screen capture was unavailable or canceled. Check macOS screen permissions and try again.')
      } finally {
        if (timer) clearTimeout(timer)
        // Keep Triage hidden until the accessibility snapshot has finished reading the same screen.
        await fields
        restore()
      }
    }
  }
}
