# Screen help: Simplify this screen and Is this safe?

Two one-tap (or one-sentence) helpers that look at the current screen and answer with a card instead of a chat message.

| Trigger | What you get |
|---|---|
| **Simplify this screen** button, or say "what can I do here?", "simplify this page", "this is too confusing", "I'm lost" | One plain sentence about the screen and **3–5 big task buttons** ("Track my package", "Return an item"). A 👉 button points at the control on screen; a 💬 button explains. |
| **Is this safe?** button, or say "is this safe?", "is this a scam?", "should I trust this?" | A green, amber or red card: **No warning signs / Be careful / This looks like a scam**, what Triage noticed, and one plain next step |

Both are spoken aloud when you asked by voice (or always, if Settings → Voice replies → Always).

## How it works

```
AssistantPanel.analyzeScreen(kind)
  └ captureScreen() (or the screenshot already waiting) ──▶ coordinator.analyzeScreen({ captureId, kind, source })
                                                           ├ takes the screenshot (single use, never saved)
                                                           ├ gateway.analyze(kind): Claude or Gemini, one JSON object
                                                           ├ parseScreenAnalysis(): strict zod schema, or a readable error
                                                           └ request log (only if opted in): route simplify|safety
  ◀── { kind: 'simplify', view } | { kind: 'safety', check }
ScreenHelpCard renders it; a button runs the existing "show me where" (arrow) or "explain" flow
```

- **Prompts:** `analysisSystemPrompt()` in `src/main/assistant/model.ts`.
- **Schemas:** `src/shared/screen-analysis-contracts.ts`. Unknown verdicts or action kinds, empty action lists, and extra fields are rejected.
- **History:** results are not saved, because they describe a moment on screen, not a conversation.

## Safety rules in the prompts

- **Screen text can't give orders.** Everything in the screenshot is treated as untrusted, so a scam page can't instruct Triage.
- **Never suggest risky steps.** Triage doesn't suggest entering passwords, payment details or Social Security numbers, or buying anything.
- **The safety check never promises.** "looks_safe" only means no warning signs are visible, and an unclear screen gets "be_careful".
- **What it looks for:** fake virus or "account locked" pop-ups, support phone numbers, countdowns and threats, gift card, wire or crypto requests, remote-access installs, lookalike website addresses, too-good-to-be-true prizes, pre-checked add-ons, hidden subscriptions, and requests for codes or bank details.

Simplify buttons never click anything themselves. They point (arrow) or explain, and the person stays in control.

## Guided help: one step at a time

Say or type "help me attach a photo", "walk me through sending this" or "how do I print this?". Instead of a long list of steps, Triage outlines one button at a time:

1. It takes a screenshot (private fields blacked out; not sent if that check couldn't run) and reads the app's on-screen controls.
2. The model gets the goal and the steps already given, and returns **only the next step**: one sentence of at most 14 words ("Click the paperclip button at the bottom."), the control to outline, and whether the goal is done.
3. Triage draws the box (the same outline as "Show me where") and shows **Step 2: Click the paperclip…** in chat. When you asked by voice, it reads that one sentence aloud.
4. **Click the outlined button** and Triage looks again about 1.5 seconds later. Saying or typing "next", "done", "okay" or "what now", or pressing **Next step**, does the same.

The guide ends when the goal is done, when you press **Stop guiding** or say "stop", when you ask something else, after 12 steps, or after 10 minutes untouched.

```
router → { kind: 'guide', goal } ──▶ GuideSession (src/main/assistant/guide.ts)
  runGuideStep(): captureScreen → locateElements → gateway.locate(…, guide: { goal, done })
                  → parseGuideReply (src/main/screen/coordinates.ts) → pointAt → outline
  highlights.onClicked (current step only) ──▶ guideNext() ──▶ next step
```

- **Prompt:** `guideSystemPrompt()` in `src/main/assistant/model.ts`. The goal and earlier steps are quoted as data; it never suggests typing secrets or paying.
- **Speech:** every reply is read aloud for at most two sentences (about 15 seconds); the rest stays on screen.

## Not built yet

- Automatic background checks while a browser is in front. This would need repeated screen captures, and should be opt-in with a visible indicator.
- Caregiver text alerts (Amazon SNS) on "likely_scam".
- None of this has been tried with a live model yet.
