# Triage — MVP Task Checklist

## F1. Desktop character and chat bubble

F1.1–F1.6 are implemented. Phase 7 verifies compiled desktop movement, hide/restore, restart, and cleanup while a request is pending. See the [Phase 7 handoff](Phase-7-Handoff.md) for current acceptance and the Phase 1 handoff for historical platform checks.

- [x] **F1.1:** scaffold Electron/React/TypeScript with separate main, preload, and renderer builds; enable a single-instance lock.
- [x] **F1.2:** create companion and chat windows, clamp saved positions, and handle display removal.
- [x] **F1.3:** implement click-versus-drag behavior, hide/show, and an explicit quit option.
- [x] **F1.4:** add character assets and state-driven animations.
- [x] **F1.5:** add a menu-bar/tray fallback or keyboard shortcut so a hidden companion can be restored.
- [x] **F1.6:** ensure quit cancels work, closes owned browser resources, stops timers, and closes the database.

## F2. Text conversation and request routing

Phase 2 text conversations, key setup, recent context, persistence, history, and cancellation are implemented. Phase 6 adds validated text/flight routing and linked flight clarifications; screen modes continue through their explicit capture controls. See [Phase 2 handoff](Phase-2-Handoff.md) for verification and scope.

- [x] **F2.1:** implement messages, pending state, errors, and submit handling; reject empty or over-limit input.
- [x] **F2.2:** persist the user message before dispatching the request.
- [x] **F2.3:** integrate the Anthropic SDK; validate the key, handle authentication, network failures, rate limits, and unavailable models.
- [x] **F2.4:** define and validate routing/response schemas with Zod.
- [x] **F2.5:** reconstruct a bounded recent context from stored messages; distinguish historical text from current instructions.
- [x] **F2.6:** support clarifications linked to the original task; reopening old history never starts execution.
- [x] **F2.7:** persist every user-facing reply and displayed status. MVP responses can appear as complete messages; token streaming is optional.

## F3. Configurable Shake to Help

Phase 4 implements F3.1–F3.6. All 50 tests pass and native Mac checks cover opt-in, instruction editing, restart persistence, reset, and disable. Physical mouse/trackpad tuning and a paid shake-to-Claude response remain demo-machine acceptance checks. See the [Phase 4 handoff](Phase-4-Handoff.md).

- [x] **F3.1:** sample `screen.getCursorScreenPoint()` in the main process and store a bounded movement buffer.
- [x] **F3.2:** implement a pure detector using direction changes, distance, timing, and cooldown.
- [x] **F3.3:** store enabled/disabled and instruction settings; provide reset to default.
- [x] **F3.4:** snapshot trigger position/display, acknowledge immediately, and dispatch through the same request path as chat.
- [x] **F3.5:** suppress repeated activation during a task, character drag, or cooldown; record a declined busy trigger without creating a screenshot queue.
- [x] **F3.6:** pause/reset detection across sleep, wake, and major display changes.

## F4. Screenshot analysis

Phase 3 implements F4.1–F4.7. Native Mac capture/preview/discard/expiry checks and all 33 automated tests pass. Live Claude image output still needs a user key; external-display/fullscreen acceptance remains for the demo setup. See the [Phase 3 handoff](Phase-3-Handoff.md).

- [x] **F4.1:** implement permission check, capture attempt, and actionable recovery errors.
- [x] **F4.2:** match `desktopCapturer` screen sources to display identifiers; fail clearly if no source can be matched.
- [x] **F4.3:** request a useful image size, inspect actual returned image dimensions, and preserve aspect ratio; do not assume requested thumbnail size equals actual dimensions.
- [x] **F4.4:** create an in-memory capture record with UUID, timestamp, display bounds, image size, scaling/cropping metadata, and cursor coordinates.
- [x] **F4.5:** send the relevant image and question through the vision-capable model adapter; include cursor position in the image's coordinate system.
- [x] **F4.6:** limit image/context size according to the chosen model and current API documentation; release image references after use.
- [x] **F4.7:** save capture metadata and resulting user-facing response, without saving screenshot bytes by default.

## F5. Visual highlighting

Phase 5 implements F5.1–F5.6 for the current desktop flow. All 72 tests pass; the native fixture verified display bounds, click-through, retained focus, expiry, and dismissal. A paid localization and mixed-display/fullscreen checks remain manual acceptance. Managed-page navigation invalidation is conditional on the future browser implementation. See the [Phase 5 handoff](Phase-5-Handoff.md).

- [x] **F5.1:** define and validate the rectangle schema; reject NaN, out-of-bounds, empty, or impossible targets.
- [x] **F5.2:** implement mapping as pure functions and test Retina, nonzero display origins, and resized images.
- [x] **F5.3:** render a click-through, non-focusable overlay with an explanation in chat.
- [x] **F5.4:** keep highlights visible until the target is clicked or manually dismissed; clear on a new request, task start, or display geometry change. The November 10 follow-up replaces the original three-second expiry and enlarges the outline; compilation is verified, with live click acceptance still pending.
- [x] **F5.5:** offer dismiss via chat and optionally register Escape only while the highlight is visible.
- [x] **F5.6:** reject stale responses after cancellation or capture replacement. If a managed page navigated, discard its previous highlight.

## F6. Alaska Airlines flight-search workflow

Phase 6 implements F6.1–F6.10, browser coordination/cancellation, and durable action recording. Build and all 92 tests pass; native Electron acceptance verified a live search, Stop during navigation, and history reopen. Live one-way and round-trip searches worked with bundled Chromium. Paid Claude routing and broader demo acceptance remain for Phase 7. See [Phase 6 handoff](Phase-6-Handoff.md).

- [x] **F6.1:** inspect the live website on the demo network; prove a minimal manual/Playwright search early. Record supported form variants and browser behavior.
- [x] **F6.2:** implement clarification and airport/date/passenger validation.
- [x] **F6.3:** launch headed Chromium with a dedicated profile inside the app data directory; lock against simultaneous contexts using that profile.
- [x] **F6.4:** implement workflow steps for navigation, consent dialogs if encountered, airports, dates, trip type, passenger count, and search.
- [x] **F6.5:** build condition-based waits and per-step timeouts. Do not rely on long fixed sleeps or page `networkidle` as proof of readiness.
- [x] **F6.6:** validate relevant page state after each meaningful interaction; detect results through visible site-specific evidence, not URL change alone.
- [x] **F6.7:** return a structured `results`, `no_results`, `blocked`, or `failed` outcome with observed details and final URL. Distinguish actual empty results from an unfinished page.
- [x] **F6.8:** integrate durable action events and stop checks before every side effect.
- [x] **F6.9:** handle user-closed browser, unexpected navigation, expired page state, and worker failure. Do not bypass verification challenges.
- [x] **F6.10:** keep completed results open until app exit or an explicit browser-close action. A new task uses a new owned page only when the coordinator is idle.

## F7. Status and cancellation

Phase 7 completes coordinator transition validation and durable stage publication, native interruption handling, cancellation/close race fixes, stale-worker replacement, and combined desktop integration acceptance. All 106 automated tests pass. Live browser search/cancellation passes with a fixture model; the owner explicitly retains final live Claude verification. See the [Phase 7 handoff](Phase-7-Handoff.md).

- [x] **F7.1:** implement a transition validator and a coordinator owning the active task ID.
- [x] **F7.2:** emit brief factual status messages and persist them before display.
- [x] **F7.3:** attach an AbortController to model/network work and a cancellation token to the browser worker protocol.
- [x] **F7.4:** disable new side effects immediately on stop; reject late worker acknowledgments and model results for canceled tasks.
- [x] **F7.5:** bound browser operations. A stop check between awaited calls alone is insufficient for a hung call: after a short grace period, close the task-owned page to interrupt pending operations. If needed, terminate the owned worker, knowing this may close its browser session.
- [x] **F7.6:** record an unknown result for any already-issued action whose effect cannot be verified. Stop is not rollback and cannot retract a submitted search.
- [x] **F7.7:** provide stop in chat and a global emergency shortcut that remains usable while browser focus is active.

## F8. Saved conversations and activity history

Phase 7 completes cross-feature history integration: every request type exposes a timeline, loaded pages survive live refresh, deletion failures block new requests, and saved worker metadata is restricted to validated public fields. Native acceptance verifies restart recovery, long-history browsing, deletion/cancel/clear, and exclusion of fixture keys, raw errors, and image bytes. Paid Claude and physical display/gesture checks remain owner acceptance as documented in the Phase 7 handoff.

- [x] **F8.1:** implement schema migrations, foreign keys, indexes, and transactional writes.
- [x] **F8.2:** persist messages, gesture instruction snapshots, status, pending actions, results, failures, confirmations if any, and cancellation events.
- [x] **F8.3:** implement the worker action handshake: persist pending event → acknowledge authorization → execute → persist observed outcome → authorize next step. Never authorize an action if its pre-action event could not be saved.
- [x] **F8.4:** redact known secrets and normalize error payloads before storage; omit full HTML, headers, cookies, credentials, raw SDK responses, screenshots, and hidden model reasoning.
- [x] **F8.5:** build paginated history list and detail views. Reopening history is read-only unless the user explicitly submits a new message.
- [x] **F8.6:** recover active tasks as interrupted at startup; mark unmatched pending actions as outcome unknown, without replaying them.
- [x] **F8.7:** implement deletion with cascade rules. Require stopping an active task before deleting its conversation; do not let new events repopulate an entry mid-deletion.
- [x] **F8.8:** handle write failure as a visible blocking condition for further actions. Maintain a small in-memory error notice if the database itself cannot record the failure.
