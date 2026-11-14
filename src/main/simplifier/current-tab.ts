import { execFile } from 'node:child_process'

// "/simplify" with no address rebuilds the page the person is looking at in
// their own browser. Only the address is read here; the page itself is then
// opened fresh in Triage's own Chromium, exactly like "/simplify <address>".

/** Where a current-tab address can come from, tried in order. Each returns undefined when it has nothing. */
export type TabUrlSource = () => Promise<string | undefined>

/** The address as an http(s) URL with any #fragment removed, or undefined for anything else (chrome://, file:, about:blank…). */
export function webUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    url.hash = ''
    return url.href
  } catch { return undefined }
}

/** First source with a usable web address wins; a source that fails is skipped. */
export function currentTabReader(sources: TabUrlSource[]): () => Promise<string | undefined> {
  return async () => {
    for (const source of sources) {
      let raw: string | undefined
      try { raw = await source() } catch { raw = undefined }
      const url = webUrl(raw)
      if (url) return url
    }
    return undefined
  }
}

// Asks Google Chrome for its front window's active tab. Checking "is running"
// first keeps this from launching Chrome. macOS asks once for permission for
// Triage to control Chrome; if it is refused this simply returns nothing.
const CHROME_SCRIPT = `if application "Google Chrome" is running then
  tell application "Google Chrome"
    if (count of windows) > 0 then return URL of active tab of front window
  end tell
end if
return ""`

/** The active Chrome tab's address through AppleScript (macOS only). */
export function chromeActiveTabUrl(timeoutMs = 3000): TabUrlSource {
  return () => new Promise((resolve) => {
    if (process.platform !== 'darwin') { resolve(undefined); return }
    execFile('/usr/bin/osascript', ['-e', CHROME_SCRIPT], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? undefined : String(stdout).trim() || undefined)
    })
  })
}
