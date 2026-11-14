import { chromium, type Browser } from 'playwright'
import { browserChannelFrom, browserMissingMessage, channelLaunchOptions } from '../../src/shared/browser-config.ts'

/**
 * Launch the browser that browser-backed tests run in: installed Google Chrome
 * by default (headless), matching what the app drives. Set
 * TRIAGE_BROWSER_CHANNEL=chromium to use Playwright's bundled build instead.
 */
export async function launchTestBrowser(): Promise<Browser> {
  const channel = browserChannelFrom(process.env)
  try {
    return await chromium.launch({ ...channelLaunchOptions(channel), headless: true })
  } catch (error) {
    throw new Error(browserMissingMessage(channel), { cause: error })
  }
}
