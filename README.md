# Triage

## Chrome Link Warnings preview

1. Open `release/Triage.app` from Finder. For development, run `npm run phishing:build` and then `npm run dev`.
2. In Triage’s menu bar menu, turn on **Chrome Link Warnings (Preview)**. If macOS denies access, enable `release/Triage.app` in **System Settings → Privacy & Security → Accessibility**, then enable the preview again.
3. Open [the demo page](demos/link-warnings.html) in Google Chrome on the primary display and keep Chrome in front. The first two links should get **Potential phishing** and **Unencrypted HTTP** badges. The third should have no badge. The links can remain unclicked.
4. For a more realistic demo, open [the demo scenarios](demos/phishing-inbox.html) and pick a scenario from the switcher in the top right: email inbox, text messages, search results, social feed, marketplace chat or a news site pop-up. Scam links show **Potential phishing**, some ordinary links show **Unencrypted HTTP**, and the harmless ones (like the team lunch email or Mom's recipe link) show no badge. All brands are fictional, and links on the page never navigate.

The preview starts off each launch. It scans links with a destination and visible bounds in the active Chrome window’s accessibility tree. It checks up to 250 links per scan and shows up to 12 badges. The simulated phishing rule matches only `triage-phishing-demo.invalid`. HTTP indicates an unencrypted destination. Real-world phishing reputation, background tabs, other browsers, and links Chrome does not expose are outside this preview’s scope. Checks run locally and URLs are kept out of Triage’s Activity History.

### Rebuild the Finder app

With macOS command-line tools and Node.js headers installed, run:

```sh
npm run build
npm run phishing:build
node scripts/prepare-local-app.mjs
```

If your Node installation puts its headers elsewhere, set `TRIAGE_NODE_INCLUDE` to the directory containing `node_api.h`.

Quit any running copy of Triage before opening the rebuilt app. macOS may ask you to renew Accessibility permission after a rebuild.
