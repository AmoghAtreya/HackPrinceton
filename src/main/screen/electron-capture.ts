import { app, desktopCapturer, screen, systemPreferences } from 'electron'
import { resolve } from 'node:path'
import { captureSize } from './coordinates'
import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopWindows } from '../windows'
import { AppProblem } from '../assistant/errors'
import type { CapturePort } from './service'

export function electronCapture(windows: DesktopWindows, beforeCapture?: () => void): CapturePort {
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
      try {
        await delay(250)
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
        const bytes = image.toJPEG(80)
        if (bytes.length > 4000000) throw new AppProblem('capture_failed', 'The screen image is too large. Try a smaller display resolution.')
        return {
          data: bytes.toString('base64'), mediaType: 'image/jpeg' as const,
          metadata: {
            displayId: String(display.id), displayName: display.label || 'Current display',
            width, height, bounds: { ...display.bounds }, scaleFactor: display.scaleFactor, rotation: display.rotation,
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
        restore()
      }
    }
  }
}
