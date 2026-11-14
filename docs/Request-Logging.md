# Request logging ("Help improve Triage")

Opt-in logging of what people ask. The goal is to find common questions (FAQs) and missing shortcuts (for example a destination people ask for that isn't on the list), and feed the improvements back into Triage. The model is never retrained; the improvements go into Triage's prompts, buttons and destination list instead.

## Phase 1: built

- **Off by default.** Settings → **Help improve Triage** → "Share my questions".
- **Every finished request is logged once opted in:** chat, voice, Shake to Help, simplify and safety checks. The coordinator reports each one, in `report()` and `analyzeScreen()`.
- **What's logged:** one JSON line per request in `<userData>/request-log.jsonl` (mode 0600). The shape is `RequestEvent` in `src/shared/request-log-contracts.ts`:
  `source` (chat/voice/shake), `text` (the request with known API keys removed), `route` (reply, flight_search, open_page, explain, highlight, simplify, safety), `destination`, `outcome`, `reply` (shortened), `error`, `latencyMs`, `appVersion`.
- **Anonymous ID.** `installId` is a random UUID, not tied to any account. **Delete my shared questions** wipes the file and starts a new ID, so old and new entries can't be linked.
- **Never logged:** screenshots and audio.
- **Limits:** text is cut to 1,000 characters, replies to 600, and the outbox holds at most 5,000 entries.

## Phase 2: planned

```
local outbox → uploader (batches, retries) → API Gateway (API key) → Lambda
     → Amazon Comprehend DetectPiiEntities (removes names, addresses, account numbers)
     → DynamoDB  triage_requests  (installId + timestamp)
```

The app never holds AWS write credentials. It only calls API Gateway.

## Phase 3 and 4: planned

- **Finding FAQs:** a scheduled Lambda groups recent requests into topics, drafts short answers, and saves them as `approved: false`. A person approves each one.
- **Using them:**
  - "People often ask…" buttons in the empty chat.
  - Approved answers added to the chatbot's prompt as reference.
  - A report of destinations people asked for that aren't on the list yet.
