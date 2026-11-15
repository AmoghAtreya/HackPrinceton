# Triage

**A calm, voice-first tutor that lives on your Mac and teaches older and less tech-confident people to use the web by pointing at the real button, explaining it in plain words, and letting them press it themselves.**

HackPrinceton Fall 2026 · **Main track: Education** · Special tracks: Amazon, LangChain, Peri

---

## The problem

Many older adults know *what* they want to do: track a package, reorder pills, check Medicare. What they can't do is find *where* to click on a cluttered page. They get overwhelmed, give up, or wait for a family member or technician to do it for them. Each time someone else does it, they learn nothing for next time. They are also the people scammers target most.

We called a senior-living facility to check this ([interview transcript](docs/Skyline_Health_Transcript.md)). About half the residents use computers. Most of their questions are "where to go or what to click on", not broken machines. The technician isn't there every day, so residents often wait. Some residents follow spoken directions fine, and others need someone to point. Staff added that scam warnings should say *why* something is suspicious, not just "don't click".

## Our goal: help people learn, not just get it done

Triage is built to make people **more confident and more independent with technology over time**, not to keep doing things for them. Every feature leans the same way:

- **Show, don't take over.** Triage draws a box or an arrow on the real control and lets the person click it. Guided help gives one step at a time. On a simplified page, the buttons point at the real control instead of pressing it.
- **Explain why.** Answers are short and plain, read aloud, and give the next step instead of a wall of instructions. Scam warnings come with the facts behind them, so the person learns what a scam looks like.
- **Meet people where they are.** A **skill graph** keeps track of what each person already does well, using Bayesian Knowledge Tracing. Explanations skip what they already know and start with what's missing. A caregiver can mark a skill **Practice this** so Triage walks through it every time.
- **Learn from what actually happens.** Clicking the highlighted control on the first try counts as a skill shown. Losing the highlight or going back counts against it. Ratings of simplified pages teach the layout chooser which layouts work for this person.

The aim is that, over weeks, a person needs Triage less: first it points, then it reminds, and eventually they just do it.

## What Triage does

Triage is a small companion character that runs in the background on your Mac. It can see your screen when you ask it to, and it talks and listens.

| You… | Triage… |
|---|---|
| **Hold the talk button** and say "take me to my Amazon orders" | opens that page in **your own browser**, already signed in, and says so aloud |
| press **⌘⇧9** from any app and just talk | listens without opening the chat, and **answers out loud**: hands-free help on top of whatever you're doing |
| say "**where's the track package button?**" | takes a screenshot and **draws an arrow on the real control** |
| say "**help me attach a photo**" or "walk me through it" | **guided help**: boxes one button at a time with one short sentence; click it (or say "next") for the next step |
| say "**how do I…?**" | explains only the steps you don't already know, in order (the **skill graph**) |
| say "**what's on my screen?**" | explains the screen in plain language, out loud |
| **shake the mouse** over something confusing | explains what's under the cursor, hands-free |
| press **Simplify this screen**, say "simplify this page", or type `/simplify` | rebuilds a cluttered page as **3–5 big task buttons** ("Track my package") plus its real links, in large print; each button points at the real control |
| browse in Chrome with **Chrome Link Warnings** on (menu bar) | badges risky links right on the page (**Potential phishing** / **Unencrypted HTTP**) and **says a warning out loud** when a scam link appears |
| press **Is this safe?**, or say "is this a scam?" | checks the screen for scam and dark-pattern signs and shows a green, amber or red verdict with a plain next step |
| get an email that claims to be from someone you know | compares it with your **people & organizations** list and warns, with reasons, when the address doesn't match |
| say "**remember my pharmacy is CareWell on Main Street**" | saves it **on this Mac**; you can see or remove it in History |
| say "**refill my blood pressure medicine**" | runs a step-by-step refill on the demo pharmacy, asks for anything it doesn't know, and **reads everything back and waits for your "yes"** before sending |
| say "**where was I?**" | tells you which step a paused task is on |
| ask anything else by voice or text | answers briefly and reads the answer aloud |
| say "**stop**" or "**start over**" | stops instantly / starts a fresh conversation |

Built for older users:
- **Push-to-talk:** hold to talk, or tap to start and tap again to stop. From any app, **⌘⇧9** starts and stops listening (Control+Option+Space if ⌘⇧9 is taken), with a soft chime each way and a **Listening** look on the companion. The shortcut is shown under the talk button.
- **Live captions** as you speak, on-device. When you let go, **Google Gemini** writes the final transcript for accuracy, falling back to the on-device text when offline.
- **Read-back:** a slow (90%), clear neural voice reads short answers, and you can replay them. Speeds: Slower (80%), Relaxed (90%, default), Normal (100%) and Faster (115%).
- **Hands-free when the chat is closed:** answers, problems and "Sorry, I didn't quite catch that" are spoken instead of popping the chat open. Arrows and boxes still appear on screen.
- **"Did I hear that right?"** Unclear speech is put in the message box to check, never sent blindly.
- **Safe by design:** Triage only opens pages from a fixed list of approved sites, never a website address the AI makes up, so a misheard word can't send someone to a lookalike scam site.

## Demo flow (2 minutes)

1. Press **⌘⇧9**: "Take me to my Amazon orders." Your Amazon order history opens in Chrome, and Triage says "Opening your Amazon orders…".
2. "Where's the track package button?" An arrow appears on the button, and Triage explains the next step. You click it yourself.
3. Shake the mouse over a confusing pop-up. Triage explains what it is, out loud.
4. Open [the phishing demo](demos/phishing-inbox.html) with Chrome Link Warnings on. The scam link gets a badge and Triage says to be careful.
5. "Stop." It goes quiet immediately.

For the learning side (memory, the refill task graph and the layout learner, shown live on a second screen), follow the [Learning Monitor demo script](docs/Learning-Monitor.md#demo-script-about-3-minutes).

## How it works

```
             ┌──────────────────────────── Electron app (runs in the background) ─────────────────────────────┐
 ⌘⇧9 / talk button ─▶ chat window (may stay hidden): AudioWorklet → 16 kHz PCM ──IPC──▶ main process
                                                      ──▶ Apple on-device speech (free) or Amazon Transcribe
                      live captions ◀──────────────── partial text;  on release: Gemini writes the final transcript
                      voice shortcuts (stop, start over, explain, show me where) ──────┐
                      "Did I hear that right?" check                                   │
                                                                                       ▼
 macOS Accessibility (native AXSnapshot) ──▶ <screen_context> labels ──▶  Assistant coordinator
   also: private-field boxes for redaction,                                 │
   real control frames for highlights                                       ├─ fixed rules first (no model): "remember…", "refill my…",
                                                                            │   "where was I?", answers to a paused task
                                                                            │     ├─ memory ......... LangChain vector store + retriever (memory.sqlite)
                                                                            │     └─ refill task .... LangGraph graph → Playwright (demo pharmacy),
                                                                            │                         checkpoints in tasks.sqlite, pauses for "yes"
                                                                            │
                                                                            └─ router: Claude (Haiku tier for simple requests) or Gemini
                                                                                  ├─ reply .............. answer (+ trust check, + screenshot if needed)
                                                                                  ├─ open_page .......... approved list → your default browser
                                                                                  ├─ how_to ............. skill graph (BKT) → explain only what's missing
                                                                                  ├─ guide .............. one boxed step at a time on the real screen
                                                                                  ├─ simplify_page ...... simplifier (LangChain RunnableSequence +
                                                                                  │                       Thompson-sampling layout learner) → big-button window
                                                                                  ├─ remember_contact ... trust graph (people & organizations)
                                                                                  └─ flight_search ...... Playwright task browser (Alaska Air)
     screenshot (private fields blacked out) ──▶ highlight → arrow / box overlay;  simplify / safety → card

 Chrome Link Warnings: native link scanner over Chrome's accessibility tree → badges + spoken warning
 Learning Monitor: LangChain callbacks → event bus → monitor window / LAN page (read-only, masked)

 speaker ◀── Web Audio ◀── mp3 ◀──IPC── main process ◀── Amazon Polly (neural, SSML prosody 80–115%)
             (fallback: the macOS built-in voice)
```

API keys and AWS credentials stay in the main process. The chat window never sees them. Everything Triage keeps lives in SQLite files in its data folder on this Mac: `history.sqlite` (conversations and activity), `memory.sqlite`, `tasks.sqlite`, `simplifier.sqlite` (layout decisions and rewards), `skill-knowledge.sqlite` and `trust-graph.sqlite`.

### LangChain and LangGraph
- **LangGraph `StateGraph`** for multi-step tasks (the prescription refill), with `interrupt` to pause for the person and a SQLite checkpointer so tasks survive a restart.
- **LangChain vector store and `VectorStoreRetriever`** over on-device memory, with on-device `Embeddings`.
- **LangChain `RunnableSequence`** for the page simplifier: classify → choose layout → rewrite → log.
- **LangChain callbacks** feed the Learning Monitor, so every node and step it shows is a real run.

### AWS services
- **Amazon Transcribe (streaming):** optional cloud speech-to-text with live partial captions and per-word confidence. It needs an AWS account on the Paid plan. By default Triage uses **free on-device Apple speech** instead (no audio leaves the Mac).
- **Amazon Polly (neural voices):** spoken replies, with the speed set through SSML.
- *Planned:* Amazon Comprehend (removing personal details from shared questions), DynamoDB (anonymous request log for FAQs), SNS (caregiver alerts).

## Setup

Requirements: macOS on Apple Silicon, Node 22 (`.nvmrc`), and an **Anthropic (Claude) or Google AI Studio (Gemini)** API key, entered in the app's Settings. Triage picks the provider from the key and prefers Gemini Flash for Gemini keys.

```bash
npm install
npm run browser:install     # Chromium for the task browser (flight search, prescription refill, /simplify)
npm run speech:build        # free on-device speech helper (voice input)
npm run context:build       # reads on-screen controls: hides private fields in screenshots, outlines real buttons
npm run phishing:build      # link scanner for Chrome Link Warnings
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
| `src/main/index.ts`, `src/main/windows.ts` | Electron main process: tray menu, global shortcuts (⌘⇧9 talk, ⌘⇧Space chat, ⌘⇧Esc stop), windows |
| `src/main/assistant/` | coordinator, Claude and Gemini gateways, model tiers, guided-help sessions, history |
| `src/main/context/` | accessibility snapshot of the app in front: `<screen_context>`, private-field boxes, control frames |
| `src/main/screen/` | screen capture, redaction, highlight overlay that follows the real control |
| `src/main/simplifier/` | page simplifier: LangChain pipeline, Thompson-sampling layout learner, decision log, rewards, `/simplify` of the current tab |
| `src/main/skills/` | skill graph and Bayesian Knowledge Tracing tutor |
| `src/main/trust/` | people & organizations list and impersonation checks |
| `src/main/memory/` | on-device memory: LangChain vector store, retriever, embeddings |
| `src/main/tasks/` | LangGraph refill graph, SQLite checkpointer, task runner, demo pharmacy driver |
| `src/main/monitor/` | Learning Monitor: LangChain callback handler, event bus, window and LAN server |
| `src/main/phishing/` | Chrome Link Warnings monitor |
| `src/main/gestures/` | shake-to-help detector |
| `src/main/voice/` | voice sessions, Apple on-device speech, Amazon Transcribe, Gemini final transcripts, transcript store |
| `src/main/speech/` | Amazon Polly, voice reply settings |
| `src/main/logging/` | opt-in anonymous request log |
| `src/shared/` | contracts between processes; `destinations.ts` is the approved list of places Triage can open, `skill-catalogue.ts` the skill graph |
| `src/renderer/src/` | React UI: companion, chat, talk button, settings, History (memories, what I've learned), trust warnings |
| `src/renderer/src/voice/` | mic capture, voice shortcuts, chime, speech player |
| `src/worker/` | Playwright task browser (flight search) |
| `native/speech/`, `native/context/`, `native/phishing/` | Swift speech helper; Objective-C++ accessibility snapshot and link scanner |
| `demos/`, `demo/sites/` | phishing, link-warning and impersonation demo pages; cluttered news and mock pharmacy sites |
| `scripts/` | native builds, Finder app packaging, Learning Monitor and simplifier demos, routing eval |
| `evals/routing-cases.json` | labelled routing cases for `npm run eval:routing` |
| `landing/` | landing page |
| `docs/` | [Voice input](docs/Voice-Transcribe.md) · [Spoken replies](docs/Speech-Polly.md) · [Page navigation](docs/Page-Navigation.md) · [Screen help](docs/Screen-Help.md) · [Learning Monitor](docs/Learning-Monitor.md) · [Request logging](docs/Request-Logging.md) · [Memory topology (exploration)](docs/Memory-Topology-and-Mesh.md) · [User interview](docs/Skyline_Health_Transcript.md) · [Product overview](docs/Triage-Product-Overview.md) · [Tech spec](docs/Triage-Technical-Specification.md) |

## Privacy and safety

- **Screenshots** are taken only when you ask (button, voice shortcut or shake), are sent to the model for that one request, and are never saved.
- **Voice audio** is captured only while you hold or tap the talk button and is never saved. By default it's transcribed **on this Mac** (Apple on-device speech, no server fallback). If you opt into Amazon Transcribe, it's streamed to AWS instead. Transcripts are saved on this Mac.
- **Conversations** are saved on this Mac (unencrypted). Known API keys are removed from saved text.
- **Help improve Triage** (off by default) keeps an anonymous log of questions only, never screenshots or audio. You can delete it in Settings at any time.
- **Memory and task progress** ("remember…", refill answers, paused tasks) are saved on this Mac (unencrypted) and never sent to an embedding service. You can see and remove memories in History.
- **Triage never buys anything, enters passwords or payment details, or picks a flight fare.** Pages open only from the approved list, over https. The only form it fills by itself is the built-in demo pharmacy, and it always reads the details back and waits for your "yes" before sending.

## Chrome Link Warnings preview

1. Open `release/Triage.app` from Finder. For development, run `npm run phishing:build` and then `npm run dev`.
2. In Triage’s menu bar menu, turn on **Chrome Link Warnings (Preview)**. If macOS denies access, enable `release/Triage.app` in **System Settings → Privacy & Security → Accessibility**, then enable the preview again.
3. Open [the demo page](demos/link-warnings.html) in Google Chrome on the primary display and keep Chrome in front. The first two links should get **Potential phishing** and **Unencrypted HTTP** badges. The third should have no badge. The links can remain unclicked.
4. For a more realistic demo, open [the demo scenarios](demos/phishing-inbox.html) and pick a scenario from the switcher in the top right: email inbox, text messages, search results, social feed, marketplace chat or a news site pop-up. Scam links show **Potential phishing**, some ordinary links show **Unencrypted HTTP**, and the harmless ones (like the team lunch email or Mom's recipe link) show no badge. All brands are fictional, and links on the page never navigate.

The preview starts off each launch. It scans links with a destination and visible bounds in the active Chrome window’s accessibility tree. It checks up to 250 links per scan and shows up to 12 badges. The simulated phishing rule matches only `triage-phishing-demo.invalid`. HTTP indicates an unencrypted destination. Real-world phishing reputation, background tabs, other browsers, and links Chrome does not expose are outside this preview’s scope. Checks run locally and URLs are kept out of Triage’s Activity History.

When a new phishing link appears, Triage also **says a short warning out loud** ("Be careful. This page has a link that may be a scam…"), even when the chat is closed. It waits while the microphone is on, so Triage never records its own voice.

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

## Memory and multi-step tasks (LangChain + LangGraph)

**Memory.** Say "remember that my pharmacy is CareWell on Main Street" (or `/remember …`) and Triage saves it to `memory.sqlite` on this Mac. Memories are stored in a LangChain vector store and found with a LangChain `VectorStoreRetriever`. The embeddings are computed **on this Mac** (feature hashing with a small synonym table for health, money and errand words, so "pills" finds "medication"), because memories hold personal details. Any LangChain `Embeddings` can replace it later without changing the store or the tasks. **History** lists what Triage remembers, and you can remove any of it.

**Refill a prescription.** "Refill my blood pressure medicine" (or `/refill …`) runs a LangGraph state machine against the demo pharmacy site ([demo/sites/pharmacy-refill.html](demo/sites/pharmacy-refill.html)):

```
recall → gather ⟲ → open → fill → confirm → submit → remember → END
```

- **recall** looks up your name, date of birth, prescription number, pharmacy and pickup time in memory.
- **gather** asks for one missing detail at a time, saves the answer, and loops. The next refill needs no questions.
- **open / fill** use the Playwright task browser to fill the form.
- **confirm** reads every field back and pauses until you say "yes". The submit button's risk is decided by fixed rules over the page, never by the model, and anything involving money or passwords is refused.
- **remember** saves the steps as a recipe for next time.

A checkpoint is saved after every step (`tasks.sqlite`), so a task survives a restart. "Where was I?" reads it back, and the History tab shows the progress. While a task is waiting, your next chat message is its answer. These commands are recognised by fixed rules in the coordinator and never go through the model's router.

## Learning Monitor

A separate window (or a page on a second device) that shows live what Triage's learning parts are doing: each LangGraph node as it runs, the four traced steps of the simplifier's LangChain `RunnableSequence`, memory lookups with their match scores, the layout learner's odds and the rewards that update it. The counters come from LangChain's own callback system. Personal numbers are masked, and the page is read-only.

Open it from the menu bar (**Show learning monitor**), or start Triage with `TRIAGE_MONITOR=1`. To watch from another device on the same network, start with `TRIAGE_MONITOR_SHARE=1` and open the link with the secret shown in the monitor's header. See [docs/Learning-Monitor.md](docs/Learning-Monitor.md) for the 3-minute demo script.

For a scripted run with no API key (it drives the real memory, refill graph and simplifier code against the mock pharmacy, with a simulated person rating pages so the layout odds visibly shift; all data goes in a temporary folder):

```bash
node --experimental-strip-types scripts/demo-learning-monitor.ts --share
```

## What's next

- Upload the opt-in request log (API Gateway → Lambda + Amazon Comprehend → DynamoDB) and turn it into approved FAQs.
- Caregiver mode: custom destinations and text alerts (Amazon SNS) when a scam is detected.
- Optional automatic safety checks while a browser is in front.
