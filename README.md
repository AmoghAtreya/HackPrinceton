# Triage

**A calm, voice-first helper that lives on your Mac and helps older and less tech-confident people get things done on the web, by pointing, explaining and talking them through it.**

HackPrinceton Fall 2026 · Tracks: Amazon *Best Practical AI*, Education

---

## The problem

Many older adults know *what* they want to do: track a package, reorder pills, check Medicare. What they can't do is find *where* to click on a cluttered page. They get overwhelmed, give up, or call a family member. They are also the people scammers target most.

## What Triage does

Triage is a small companion character that runs in the background on your Mac. It can see your screen when you ask it to, and it talks and listens.

| You… | Triage… |
|---|---|
| **Hold the talk button** and say "take me to my Amazon orders" | opens that page in **your own browser**, already signed in, and says so aloud |
| say "**where's the track package button?**" | takes a screenshot and **draws an arrow on the real control** |
| say "**what's on my screen?**" | explains the screen in plain language, out loud |
| **shake the mouse** over something confusing | explains what's under the cursor, hands-free |
| press **Simplify this screen**, or say "what can I do here?" | turns a cluttered page into **3–5 big task buttons** ("Track my package") that point or explain |
| browse in Chrome with **Chrome Link Warnings** on (menu bar) | badges risky links right on the page: **Potential phishing** / **Unencrypted HTTP** (see below) |
| press **Is this safe?**, or say "is this a scam?" | checks the screen for scam and dark-pattern signs and shows a green, amber or red verdict with a plain next step |
| ask anything else by voice or text | answers briefly and reads the answer aloud |
| say "**stop**" or "**start over**" | stops instantly / starts a fresh conversation |

Built for older users:
- **Push-to-talk:** hold to talk, or tap to start and tap again to stop.
- **Live captions** as you speak, on-device. When you let go, **Google Gemini** writes the final transcript for accuracy, falling back to the on-device text when offline.
- **Read-back:** a slow (90%), clear neural voice reads short answers, and you can replay them.
- **"Did I hear that right?"** Unclear speech is put in the message box to check, never sent blindly.
- **Safe by design:** Triage only opens pages from a fixed list of approved sites, never a website address the AI makes up, so a misheard word can't send someone to a lookalike scam site.

## Demo flow (2 minutes)

1. Hold **Hold to talk**: "Take me to my Amazon orders." Your Amazon order history opens in Chrome, and Triage says "Opening your Amazon orders…".
2. "Where's the track package button?" An arrow appears on the button, and Triage explains the next step.
3. Shake the mouse over a confusing pop-up. Triage explains what it is, out loud.
4. "Stop." It goes quiet immediately.

## How it works

```
             ┌──────────────────────── Electron app (runs in the background) ─────────────────────────┐
 mic ──▶ chat window: AudioWorklet → 16 kHz PCM ──IPC──▶ main process ──▶ Apple on-device speech (free) or Amazon Transcribe
                     live captions ◀───────────────────── partial / final text
                     voice shortcuts (stop, explain, show-me-where) ─┐
                     "Did I hear that right?" check                  │
                                                                     ▼
                                                   Assistant coordinator ──▶ Claude or Gemini (routes the request)
                                                     ├─ reply ............ answer in chat
                                                     ├─ open_page ........ approved list → your default browser
                                                     ├─ flight_search .... Playwright task browser (Alaska Air)
                                                     ├─ screenshot + highlight → arrow overlay on the real screen
                                                     └─ screenshot → simplify (task buttons) / safety check (verdict card)
 speaker ◀── Web Audio ◀── mp3 ◀──IPC── main process ◀── Amazon Polly (neural, SSML prosody 90%)
             (fallback: the macOS built-in voice)
```

AWS credentials stay in the main process. The chat window never sees them.

### AWS services
- **Amazon Transcribe (streaming):** optional cloud speech-to-text with live partial captions and per-word confidence. It needs an AWS account on the Paid plan. By default Triage uses **free on-device Apple speech** instead (no audio leaves the Mac).
- **Amazon Polly (neural voices):** spoken replies, with the speed set through SSML.
- *Planned:* Amazon Comprehend (removing personal details from shared questions), DynamoDB (anonymous request log for FAQs), SNS (caregiver alerts).

## Setup

Requirements: macOS on Apple Silicon, Node 22 (`.nvmrc`), and an **Anthropic (Claude) or Google AI Studio (Gemini)** API key, entered in the app's Settings. Triage picks the provider from the key and prefers Gemini Flash for Gemini keys.

```bash
npm install
npm run browser:install     # Chromium for the flight-search task browser
npm run speech:build        # free on-device speech helper (voice input)
npm run context:build       # reads on-screen controls: hides private fields in screenshots, outlines real buttons
```

Then allow Triage in **System Settings → Privacy & Security → Accessibility**. Without it (or without `context:build`), guided help and screenshots sent without a preview are refused, because private fields can't be hidden.

> **After every `git pull`, run `npm install` again.** Teammates add packages (for example LangChain and LangGraph for memory and tasks); without them Triage fails to build or start. Re-run `npm run speech:build` too if `native/speech/` changed.

AWS credentials for spoken replies (Amazon Polly). Create an IAM user that has only these permissions (Transcribe is only needed if you opt into it):

```json
{ "Effect": "Allow", "Action": ["polly:SynthesizeSpeech", "transcribe:StartStreamTranscription"], "Resource": "*" }
```

Then:

```bash
# ~/.aws/credentials holds a [triage-dev] profile with that user's key
AWS_PROFILE=triage-dev AWS_REGION=us-east-1 npm run dev
# New Free-plan AWS accounts: Polly works only in us-east-2 (standard voices), so add:
#   TRIAGE_POLLY_REGION=us-east-2
# To use Amazon Transcribe instead of on-device speech (Paid-plan accounts only), add:
#   TRIAGE_SPEECH_TO_TEXT=transcribe
```

- **First time you press Hold to talk:** macOS asks for **microphone** access (Triage), then **Speech Recognition** (Triage Speech).
- **Without AWS credentials:** voice input still works (it's on-device). Spoken replies then use the Mac's built-in voice.

```bash
npm test          # node:test suite
npm run typecheck
npm run build
```

## Project layout

| Path | What |
|---|---|
| `src/main/` | Electron main process: windows, assistant coordinator, screen capture and highlight overlay, gestures |
| `src/main/voice/` | voice sessions, Apple on-device speech and Amazon Transcribe backends, audio queue, transcript store |
| `native/speech/` | Swift helper app for free on-device speech recognition |
| `src/main/speech/` | Amazon Polly, voice reply settings |
| `src/shared/destinations.ts` | the approved list of places Triage can open |
| `src/renderer/src/` | React UI: chat, talk button, settings |
| `src/renderer/src/voice/` | mic capture, voice shortcuts, speech player |
| `src/worker/` | Playwright task browser (flight search) |
| `docs/` | [Voice input](docs/Voice-Transcribe.md) · [Spoken replies](docs/Speech-Polly.md) · [Page navigation](docs/Page-Navigation.md) · [Screen help](docs/Screen-Help.md) · [Request logging](docs/Request-Logging.md) · [Product overview](docs/Triage-Product-Overview.md) · [Tech spec](docs/Triage-Technical-Specification.md) |

## Privacy and safety

- **Screenshots** are taken only when you ask (button, voice shortcut or shake), are sent to the model for that one request, and are never saved.
- **Voice audio** is captured only while you hold or tap the talk button and is never saved. By default it's transcribed **on this Mac** (Apple on-device speech, no server fallback). If you opt into Amazon Transcribe, it's streamed to AWS instead. Transcripts are saved on this Mac.
- **Conversations** are saved on this Mac (unencrypted). Known API keys are removed from saved text.
- **Help improve Triage** (off by default) keeps an anonymous log of questions only, never screenshots or audio. You can delete it in Settings at any time.
- **Triage never buys anything, enters passwords or payment details, or picks a flight fare.** Pages open only from the approved list, over https.

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

## Rebuild the page you're on: `/simplify`

Open any website in Google Chrome, switch to Triage and type `/simplify`. Triage reads the address of the page you have open, opens that same page in its own Chromium test browser (the "before" view), and rebuilds it as a calm, large-print page in its own window, the same way the example page works.

| Command | What it rebuilds |
|---|---|
| `/simplify` | the page open in your browser right now |
| `/simplify example.com` | a page you name |
| `/examplesimplify` | the built-in example page (`/simplify demo` still works too) |

Under the big buttons, the rebuilt page keeps **the original page's links**, grouped so they're easy to find: *Your account, orders and help* (sign in, orders, returns, cart, help), *Main menu*, *Links on this page* and *More links at the bottom of the page*. The first two start open; the longer lists open with one click. A link that leaves the site says which website it goes to. Only real http(s) links from the page are shown; the AI never adds or changes one. **Pressing a link rebuilds the page it leads to**, in the same conversation. If Triage is busy with another request, the link just opens in Triage's browser.

How Triage finds your page: first it reads the address of the window just behind Triage through macOS Accessibility (needs `npm run context:build` and Accessibility permission, and never asks for them). If that fails, it asks Google Chrome for its active tab, and macOS asks once whether Triage may control Chrome. Only the address is read from your browser. Triage's own browser has a separate profile, so **pages that need you to be signed in show their sign-in page** in the rebuilt view.

## Guided help

Ask "help me attach a photo" (or "walk me through it") and Triage guides you one step at a time: a box around the one button to press and a single short sentence, read aloud when you asked by voice. Click the outlined button, or say "next", to get the next step. See [docs/Screen-Help.md](docs/Screen-Help.md#guided-help-one-step-at-a-time).

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

## What I've learned (the skill graph)

Triage keeps a fixed catalogue of everyday computer skills and what each builds on (for example, attaching a photo to an email builds on writing an email and choosing a file). For each skill it keeps an estimate of whether you know it, updated by Bayesian Knowledge Tracing from what you actually do: asking how to do something, clicking the control Triage pointed at on the first try, losing a highlight, or going back on a simplified page. The estimates and their evidence live in `skill-knowledge.sqlite` on this Mac. An evidence row records a skill, the kind of chance and whether it went right; never your question or the page.

When you ask how to do something, Triage skips the steps you already do comfortably and explains the missing ones first, in order. Claude can only choose skills from the catalogue; anything else it names is dropped. Scores are never shown and never sent to the chat window.

**History → What I've learned** lists the skills in three plain groups. A caregiver can tick **Practice this** to have Triage walk through a skill every time, whatever the estimate says.

The page simplifier's learner now uses this per-skill knowledge instead of generic user traits. That is a new feature layout (version 2). Decisions and learned state from version 1 are kept as they were and are never trained on, loaded or evaluated together with version 2.
## What's next

- Upload the opt-in request log (API Gateway → Lambda + Amazon Comprehend → DynamoDB) and turn it into approved FAQs.
- Caregiver mode: custom destinations and text alerts (Amazon SNS) when a scam is detected.
- Optional automatic safety checks while a browser is in front.
