# Triage

## Chrome Link Warnings preview

1. On macOS with the Swift command-line tools installed, run `npm run phishing:build`, then `npm run dev`.
2. In Triage’s menu bar menu, turn on **Chrome Link Warnings (Preview)**. If macOS denies access, add `release/TriageLinkScanner` or the responsible launcher shown by macOS in **System Settings → Privacy & Security → Accessibility**, then enable the preview again.
3. Open [the demo page](demos/link-warnings.html) in Google Chrome on the primary display and keep Chrome in front. The first two links should get **Mock phishing** and **Unencrypted HTTP** badges. The third should have no badge. The links can remain unclicked.

The preview starts off each launch. It scans links with a destination and visible bounds in the active Chrome window’s accessibility tree. It checks up to 250 links per scan and shows up to 12 badges. The simulated phishing rule matches only `triage-phishing-demo.invalid`. HTTP indicates an unencrypted destination. Real-world phishing reputation, background tabs, other browsers, and links Chrome does not expose are outside this preview’s scope. Checks run locally and URLs are kept out of Triage’s Activity History.
