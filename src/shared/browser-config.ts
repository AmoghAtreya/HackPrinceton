/**
 * Which desktop browser Triage drives through Playwright.
 *
 * Default: the user's installed Google Chrome (Playwright channel "chrome"),
 * which exists on macOS, Windows and Linux desktops without extra downloads.
 * Triage always uses its OWN profile directory, never the person's everyday
 * Chrome profile, so sign-ins and history stay separate.
 *
 * Other desktop browsers plug in by adding a channel here:
 *   chrome-beta / chrome-dev / msedge  installed branded browsers
 *   chromium                           Playwright's bundled build (npm run browser:install)
 *
 * Override with TRIAGE_BROWSER_CHANNEL (read in the main process and in tests,
 * then passed explicitly to the browser worker).
 */
export const browserChannels = ['chrome', 'chrome-beta', 'chrome-dev', 'msedge', 'chromium'] as const
export type BrowserChannel = typeof browserChannels[number]
export const DEFAULT_BROWSER_CHANNEL: BrowserChannel = 'chrome'

export function isBrowserChannel(value: unknown): value is BrowserChannel {
  return typeof value === 'string' && (browserChannels as readonly string[]).includes(value)
}

export function browserChannelFrom(env: Record<string, string | undefined>): BrowserChannel {
  const requested = env.TRIAGE_BROWSER_CHANNEL?.trim()
  if (!requested) return DEFAULT_BROWSER_CHANNEL
  if (!isBrowserChannel(requested)) throw new Error(`Unsupported TRIAGE_BROWSER_CHANNEL "${requested}". Use one of: ${browserChannels.join(', ')}.`)
  return requested
}

/** Playwright launch options for a channel. "chromium" means Playwright's bundled browser, which takes no channel. */
export function channelLaunchOptions(channel: BrowserChannel): { channel?: string } {
  return channel === 'chromium' ? {} : { channel }
}

export function browserMissingMessage(channel: BrowserChannel): string {
  return channel === 'chromium'
    ? 'Playwright Chromium is not installed. Run npm run browser:install.'
    : `Could not start ${channel === 'chrome' ? 'Google Chrome' : channel}. Install it, or set TRIAGE_BROWSER_CHANNEL=chromium and run npm run browser:install.`
}
