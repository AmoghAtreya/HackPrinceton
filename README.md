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
npm run context:build
node scripts/prepare-local-app.mjs
```

If your Node installation puts its headers elsewhere, set `TRIAGE_NODE_INCLUDE` to the directory containing `node_api.h`.

Quit any running copy of Triage before opening the rebuilt app. macOS may ask you to renew Accessibility permission after a rebuild.

## Element highlights

When you ask where to click, Triage takes an accessibility snapshot of the app in front alongside the screenshot and offers the model up to 60 of its controls (id, kind, label and region; never typed values). If the model picks one, the highlight uses that control's real frame and follows it while the page scrolls, re-reading its position every 150 ms. When the control leaves the screen or you switch apps for more than a second, the highlight clears and Triage says so in chat.

This needs `npm run context:build` and **Accessibility** permission for Triage. Triage never prompts for it here: without the permission or the module, highlights fall back to the model's pixel box exactly as before. Activity History records only whether a highlight came from `element_id` or `pixel_box`.

## Simplify this page

Ask Triage to "simplify this page", choose **Simplify this page** in the menu bar menu, or pick it as the Shake to Help action. Triage reads the page in front (your own Chrome, or any app) through macOS Accessibility, runs the same simplifier used by `/simplify`, and shows the result in the simplified-page window. Views of windows that are not web pages are labelled **Simplified from screen**.

Buttons in that view never act on the real page. Pressing one highlights the real control and says "This is the button to press"; actions that submit, pay or sign in add a warning line. You press the real button yourself. Rating a page in History trains the layout policy using what Triage observed: whether you clicked the highlighted control, whether you chose **Show original page**, and whether you went back to an earlier page of the same site.

This needs `npm run context:build` and **Accessibility** permission. The page's visible text and control labels are sent to Anthropic to write the simpler version; typed values and password fields are never read.

## Private fields in screenshots

Before a screenshot is encoded, Triage blacks out password fields and fields labelled like card numbers, CVVs, PINs or SSNs, using their positions from the accessibility snapshot taken at the same moment. This happens on the raw pixels inside Triage; the unredacted image is never encoded, saved or sent. The preview says how many fields were hidden ("Hid 2 private fields"), and History keeps only that number.

If the screen cannot be checked (no Accessibility permission, no `npm run context:build`, or nothing readable in front), the screenshot is still taken and the preview says "Couldn't check for private fields" so you can look before sending. Only the app in front is checked, and very large pages may be read only in part, so treat the count as a safeguard rather than a guarantee.

## Screen context in chat, and model tiers

Plain chat messages carry a short text description of what is in front: the app name, window title, website host (never the full address), the label of the focused control and up to 25 visible controls. It is wrapped in `<screen_context>` tags, marked untrusted, and is not saved to History. It contains labels only, never typed values or page text, and needs **Accessibility** permission and `npm run context:build`; without them chat works as before.

When that text is not enough (for example "what does this picture show"), Claude can ask for a screenshot. Triage then takes one, with private fields blacked out, and asks the same question again with the image, at most once per request. If the private-field check could not run, the screenshot is not sent and Triage asks you to use **Capture screen** instead.

With **Use faster model for simple requests** on (the default, in Settings), routing and ordinary replies go to a Haiku model when your key lists one. Screenshots, "show me where" and page simplifying use the model you selected, or a Sonnet model if you selected Haiku. History records which tier answered and whether a screenshot was taken, never the content.

## People & organizations (the trust graph)

Triage keeps a local list of the people and organizations you really deal with and how they really reach you: email addresses, phone numbers and website names. It is stored in `trust-graph.sqlite` in Triage's data folder on this Mac. It holds no message text, no full web addresses and no passwords.

**What goes in.** Only three things can add to the list: a caregiver (or you) in **Settings → People & organizations**; something you tell Triage in chat and then confirm with "yes"; and the built-in organizations Triage already knows how to open (Amazon, Medicare, Social Security, USPS and others). Nothing Triage reads from the screen can add to it or change it. You can see, edit and delete every entry, and every answer you gave, in Settings.

**What it does.** When an email or a sign-in or payment page claims to be someone on your list but arrives from a different address or website, Triage shows a warning in plain words, with the facts behind it, and two buttons: **This is a scam** and **It's really them**. Your answer is remembered for that sender. Checks run when you send a chat message, and continuously if you turn on **Warn About Impersonation (Preview)** in the menu bar menu (off at each launch; needs Accessibility permission and `npm run context:build`).

**What Claude sees.** When it is relevant, Claude is told a contact's name, relationship and a partly hidden hint such as `r…@example.com`, plus the result of Triage's own check. Full addresses and numbers do not leave this Mac.

### Demo: a fake "Ravi" asking for gift cards

1. In **Settings → People & organizations**, add a person named `Ravi` (relationship `son`) with email `ravi.kumar@example.com` and phone `(555) 010-0142`. Use **Edit** to add `Ravi Kumar` under "Also known as". Or say it in chat: "My son Ravi's email is ravi.kumar@example.com and his number is 555-010-0142", then answer "yes".
2. Turn on **Warn About Impersonation (Preview)** in the menu bar menu.
3. Open [the demo message](demos/impersonation-ravi.html) in Chrome and keep it in front. Triage should open with: "This says it's from Ravi, but Ravi uses a different email. Call Ravi at the number you have." Open "Why Triage says this" to see the two addresses, the phone number on your list, and that the message asks for gift cards, says it is urgent and asks you to keep it secret.
4. Press **This is a scam**. The same sender is then flagged as a scam you reported, whatever name it uses.
