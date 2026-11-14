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
| ask anything else by voice or text | answers briefly and reads the answer aloud |
| say "**stop**" or "**start over**" | stops instantly / starts a fresh conversation |

Built for older users:
- **Push-to-talk:** hold to talk, or tap to start and tap again to stop.
- **Live captions** as you speak.
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
 mic ──▶ chat window: AudioWorklet → 16 kHz PCM ──IPC──▶ main process ──▶ Amazon Transcribe (streaming)
                     live captions ◀───────────────────── partial / final text
                     voice shortcuts (stop, explain, show-me-where) ─┐
                     "Did I hear that right?" check                  │
                                                                     ▼
                                                   Assistant coordinator ──▶ LLM (routes the request)
                                                     ├─ reply ............ answer in chat
                                                     ├─ open_page ........ approved list → your default browser
                                                     ├─ flight_search .... Playwright task browser (Alaska Air)
                                                     └─ screenshot + highlight → arrow overlay on the real screen
 speaker ◀── Web Audio ◀── mp3 ◀──IPC── main process ◀── Amazon Polly (neural, SSML prosody 90%)
             (fallback: the macOS built-in voice)
```

AWS credentials stay in the main process. The chat window never sees them.

### AWS services
- **Amazon Transcribe (streaming):** speech-to-text with live partial captions and per-word confidence.
- **Amazon Polly (neural voices):** spoken replies, with the speed set through SSML.
- *Planned:* Amazon Comprehend (removing personal details from logged requests), DynamoDB (anonymous request log for FAQs), SNS (caregiver alerts).

## Setup

Requirements: macOS on Apple Silicon, Node 22 (`.nvmrc`), and an Anthropic API key (entered in the app's Settings).

```bash
npm install
npm run browser:install     # Chromium for the flight-search task browser
```

AWS credentials for voice. Create an IAM user that has only these permissions:

```json
{ "Effect": "Allow", "Action": ["transcribe:StartStreamTranscription", "polly:SynthesizeSpeech"], "Resource": "*" }
```

Then:

```bash
# ~/.aws/credentials holds a [triage-dev] profile with that user's key
AWS_PROFILE=triage-dev AWS_REGION=us-east-1 npm run dev
```

macOS asks for microphone access the first time you press **Hold to talk**. Without AWS credentials, everything except voice still works. Spoken replies then use the Mac's built-in voice.

```bash
npm test          # node:test suite
npm run typecheck
npm run build
```

## Project layout

| Path | What |
|---|---|
| `src/main/` | Electron main process: windows, assistant coordinator, screen capture and highlight overlay, gestures |
| `src/main/voice/` | Amazon Transcribe session, audio queue, transcript store |
| `src/main/speech/` | Amazon Polly, voice reply settings |
| `src/shared/destinations.ts` | the approved list of places Triage can open |
| `src/renderer/src/` | React UI: chat, talk button, settings |
| `src/renderer/src/voice/` | mic capture, voice shortcuts, speech player |
| `src/worker/` | Playwright task browser (flight search) |
| `docs/` | [Voice input](docs/Voice-Transcribe.md) · [Spoken replies](docs/Speech-Polly.md) · [Page navigation](docs/Page-Navigation.md) · [Product overview](docs/Triage-Product-Overview.md) · [Tech spec](docs/Triage-Technical-Specification.md) |

## Privacy and safety

- **Screenshots** are taken only when you ask (button, voice shortcut or shake), are sent to the model for that one request, and are never saved.
- **Voice audio** is streamed to Amazon Transcribe only while you hold or tap the talk button, and is never saved. Transcripts are saved on this Mac.
- **Conversations** are saved on this Mac (unencrypted). Known API keys are removed from saved text.
- **Triage never buys anything, enters passwords or payment details, or picks a flight fare.** Pages open only from the approved list, over https.

## What's next

- Simplified view: turn a cluttered page into three to five big "what do you want to do?" buttons.
- Scam and dark-pattern check ("is this safe?").
- Anonymous, opt-in request log that suggests FAQs and new destinations.
- Caregiver mode: custom destinations and text alerts.
- Gemini as an alternative model.
