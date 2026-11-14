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
```

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
node scripts/prepare-local-app.mjs
```

If your Node installation puts its headers elsewhere, set `TRIAGE_NODE_INCLUDE` to the directory containing `node_api.h`.

Quit any running copy of Triage before opening the rebuilt app. macOS may ask you to renew Accessibility permission after a rebuild.

## What's next

- Upload the opt-in request log (API Gateway → Lambda + Amazon Comprehend → DynamoDB) and turn it into approved FAQs.
- Caregiver mode: custom destinations and text alerts (Amazon SNS) when a scam is detected.
- Optional automatic safety checks while a browser is in front.
