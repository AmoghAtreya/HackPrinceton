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

/**
 * Scale a "wait for something that SHOULD appear" timeout. Positive waits only
 * cost time when they fail, so slow machines can raise TRIAGE_TEST_TIMEOUT_SCALE
 * (e.g. 4) without slowing passing runs. Do not scale waits that assert
 * something never appears; those stay short on purpose.
 */
export function testTimeout(ms: number): number {
  const scale = Number(process.env.TRIAGE_TEST_TIMEOUT_SCALE ?? 1)
  return Math.round(ms * (Number.isFinite(scale) && scale >= 1 ? scale : 1))
}
