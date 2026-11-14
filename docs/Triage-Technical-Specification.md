# Triage — macOS Technical Specification
**Target:** locally running macOS hackathon MVP, built with Electron, React, and TypeScript.

This specification translates the [Triage Product Overview](./Triage-Product-Overview.md) into components, interfaces, implementation tasks, and acceptance criteria. It describes the full MVP, including future work. Phases 1–6 are implemented; see their handoffs for actual verification. Phase 5 adds visual highlighting with validated pixel localization, native click-through guidance, and 72 passing tests. Paid model localization remains a separate acceptance check. Phase 4 adds configurable opt-in Shake to Help, with synthetic detection/integration tests and native Mac Settings checks. Physical gesture and paid model acceptance remain. Phase 3 adds native capture, local preview, and the Claude image-request path; a paid live image response still needs a user key. Phase 6 adds the compiled Playwright utility worker, validated flight clarification, durable browser action authorization, progress, cancellation, and verified Alaska searches. All 92 tests pass; native Electron acceptance covers live results, cancellation during navigation, and history reopen. Paid end-to-end Claude routing and broader integration acceptance remain for Phase 7; see the [Phase 6 handoff](Phase-6-Handoff.md).

## 1. Product goal

Triage is a small animated desktop companion. Users type requests or shake their cursor to invoke a configured instruction. It explains the visible screen, highlights a relevant control, and completes one supported browser workflow. It records conversations and task activity so users can review what happened.

The MVP must demonstrate eight capabilities:

1. Movable desktop character with basic animation and a chat bubble.
2. Text input and contextual follow-up conversation.
3. Shake to Help with one configurable instruction.
4. Screenshot-based explanations.
5. Visual highlighting on the desktop.
6. A complete Alaska Airlines flight-search workflow.
7. Visible task status and cancellation.
8. Persistent local conversation and action history.

The intended experience is: **ask or shake → explain, guide, or act → verify → review the record.**

## 2. Decisions and scope boundaries

### 2.1 Platform

- Target macOS 14 or newer as the project's initial test target, using an Electron release compatible with the actual demo machines. This is a project support decision, not Electron's minimum OS requirement.
- Prioritize Apple Silicon. Use arm64 Node, Electron, and native dependencies together. Intel support is a later validation task unless the demo requires it.
- Commit to one display and ordinary desktop windows for the demo. Test fullscreen apps and Spaces, but do not promise universal overlay behavior across them.
- Run from the local checkout. An installer, public download, auto-updater, notarization, and App Store submission are not MVP deliverables.
- A local `.app` build is an optional fallback if development-mode permissions are unreliable. Permission testing must use the exact build and launch method intended for the demo.

Electron supports macOS and exposes desktop window, display, and capture capabilities. [Electron overview](https://www.electronjs.org/docs/latest), [window API](https://www.electronjs.org/docs/latest/api/browser-window).

### 2.2 What “local” means

The application, cursor detection, screenshots, overlays, browser execution, and history database run on the Mac. Relevant text and images are sent to Anthropic for model inference. Internet access and a user-provided Anthropic API key are required for AI responses and the airline website.

There is no hosted application backend, user account system, or cloud history synchronization in the MVP.

### 2.3 Computer control boundary

The committed action capability is a supported workflow inside a browser session Triage launches. It does not include arbitrary control of Finder, System Settings, existing Safari tabs, or the user's personal Chrome session.

Use a visible Playwright-managed Chromium window with a dedicated Triage profile. Switching to installed Chrome is a tested fallback if the airline flow requires it. Do not attach to the user's normal browser profile. Playwright documents persistent contexts and warns against using the default Chrome profile for automation. [BrowserType API](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context).

Future general desktop control would require a separate macOS integration, Accessibility permissions, and new tests. Electron alone is not a universal mouse-and-keyboard automation engine.

### 2.4 Explicit exclusions

Speech synthesis, reminders, calendar integration, folder indexing, arbitrary saved workflows, purchasing tickets, payment entry, browser extensions, continuous screen recording, and general autonomous browsing are outside the committed MVP. Voice input is now in scope through Amazon Transcribe; see [Voice-Transcribe.md](Voice-Transcribe.md).

The configurable shake instruction can request explanations and visual guidance. It cannot override application restrictions or execute arbitrary code.

## 3. Technology stack

- **Desktop runtime — Electron:** app lifecycle, windows, screen capture, cursor position, inter-process communication, and protected credential handling.
- **UI — React + TypeScript:** character, conversation, settings, history, and overlay rendering. Use CSS animation or a sprite sheet; avoid a separate animation engine initially.
- **Build tooling — electron-vite + npm:** development builds for main, preload, and renderer code. Use a lockfile and document the required development Node version. [electron-vite guide](https://electron-vite.org/guide/).
- **Model integration — `@anthropic-ai/sdk`:** direct Claude API calls from the local coordinator. Select a currently available vision/tool-capable model during implementation, validate it with the team's keys, and pin its model identifier in configuration. Do not hard-code an unverified model name into UI code. [Anthropic SDK overview](https://platform.claude.com/docs/en/cli-sdks-libraries/overview).
- **Runtime validation — Zod:** validate IPC input, model output, workflow arguments, and worker messages.
- **Browser automation — Playwright:** visible browser, semantic locators, explicit state checks, and a tested airline workflow.
- **Persistence — SQLite through built-in `node:sqlite.DatabaseSync`:** transactions, ordered activity events, conversation retrieval, and deletion. Phase 2 verified this API in Electron’s embedded Node 24.22.2 runtime, avoiding a separate native database addon. Keep short operations in the main process; do not run large scans there. [Node SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
- **Credentials — Electron `safeStorage`:** encrypt the API-key value using the macOS-backed mechanism, save only the encrypted blob, and expose only configured/not-configured status to the UI. This is not encryption of the history database. [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
- **Tests — Node’s built-in test runner and Playwright fixtures:** Phase 2 uses native TypeScript stripping for service, persistence, credential, and SDK tests. Phase 6 adds controlled Chromium outcome fixtures and a native Electron live-search/cancellation/history fixture; real macOS smoke tests supplement automated checks.

Pin mutually compatible package versions and commit `package-lock.json`. Phase 2 uses the runtime’s built-in SQLite rather than the originally proposed better-sqlite3 dependency. If future work adds native dependencies, configure their Electron/architecture rebuild and verify loading inside Electron, not just system Node. [Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules).

## 4. Process architecture

```text
React windows: character/chat | settings/history | highlight overlay
                        ↕ narrow preload bridge
Electron main process
  ├─ IPC validation and window management
  ├─ task coordinator and Claude adapter
  ├─ gesture detector and screen capture service
  ├─ coordinate mapping and highlight controller
  ├─ SQLite history writer and credential/settings store
  └─ browser worker supervisor
                        ↕ typed messages, action acknowledgments
Electron utility process: Playwright workflow runner
                        ↕
Visible Chromium window using a dedicated Triage profile

Electron main process ↔ Anthropic API over HTTPS
```

### 4.1 Renderer responsibilities

Render local UI, collect input, display persisted events, and request specific application operations through the preload bridge. Render model text as plain text or sanitized Markdown. Do not expose Node.js, raw IPC, filesystem access, API keys, or arbitrary browser commands to React.

### 4.2 Main-process responsibilities

Own application state, permissions, secrets, persistence, model calls, screenshots, and task scheduling. All external inputs are validated here. Maintain one active request at a time for the MVP, including screen requests, to avoid conflicting overlays, captures, and action runs.

All network operations are asynchronous. Small SQLite writes may be synchronous; avoid image processing loops or unbounded database work on the main event loop.

### 4.3 Browser worker

Use `utilityProcess.fork` to run the compiled Playwright runner in a separate Node-capable process. It receives validated workflow arguments, not the Anthropic key. The worker reports proposed actions and waits for persistence acknowledgment before executing each external action. [Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process).

Worker exit must not crash the UI. A worker crash ends the associated task as failed or interrupted, marks any in-flight action outcome unknown, and prevents automatic replay.

## 5. Suggested repository structure

```text
src/
  main/
    index.ts
    windows.ts
    ipc.ts
    tasks/{coordinator,state-machine}.ts
    model/{client,schemas,prompts}.ts
    screen/{capture,coordinates,highlight}.ts
    gestures/shake-detector.ts
    browser/{supervisor,protocol}.ts
    history/{database,repository,redaction}.ts
    settings/{store,credentials}.ts
  preload/index.ts
  renderer/
    components/{Character,ChatBubble,TaskStatus}.tsx
    views/{Settings,History,HistoryDetail,Overlay}.tsx
    styles/
  worker/
    browser-runner.ts
    workflows/alaska-flight-search.ts
  shared/
    contracts.ts
    schemas.ts
    errors.ts
tests/
  unit/
  integration/
  browser/fixtures/
resources/character/
```

Feature contracts live in `shared/`. Keep Playwright selectors out of React and model prompts; keep model calls out of the browser worker.

## 6. macOS windows, focus, and permissions

### 6.1 Window arrangement

- **Companion:** transparent, frameless, resizable only through application logic, with a small footprint and optional always-on-top behavior. Persist its position and clamp it into the current work area on startup.
- **Chat:** a separate small window anchored near the character, repositioned away from screen edges. It takes keyboard focus only when the user opens it to type.
- **Settings/history:** a normal app window with sufficient room for readable forms and timelines.
- **Highlight:** transparent, non-focusable, click-through window covering the chosen display. It must never intercept normal clicks or obscure the stop control.

Handle drag separately from click so moving the character does not repeatedly open chat. Do not make an enormous mostly transparent character window that consumes desktop clicks. Test overlay stacking without stealing focus from the browser.

### 6.2 Permission setup

Require Screen Recording/screen-capture permission for screenshot features. Phase 3 checks Electron's permission status and enters native capture only when already granted; otherwise it gives System Settings and restart instructions. Distinguish denial from an empty or failed source. Permission changes may require a restart; explain recovery and retest.

Request microphone access only when the user first presses the talk button (voice input via Amazon Transcribe), and only for the chat window; never request camera or system-audio access. Accessibility permission is not needed solely for Playwright page automation or sampling cursor position through Electron's screen API; it becomes relevant if native desktop input injection is added later. Do not request broad permissions preemptively. [Electron system preferences](https://www.electronjs.org/docs/latest/api/system-preferences), [desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer/).

Development launches can have a different permission or credential identity from a packaged app. Test on the actual Mac early, keep launch paths stable, and verify permission and `safeStorage` behavior after restart. If protected credential storage is unavailable or inconsistent during development, allow a session-only key held in memory; never silently fall back to plaintext.

## 7. Feature implementation specifications and tasks

Task IDs below can become issues or a team checklist. Dependencies describe build order rather than fixed individual assignments.

### F1. Desktop character and chat bubble

**Behavior:** the character is present while the app runs, can be moved, opens chat, and reflects coordinator state. Basic states: idle, thinking, working, and attention/error. Respect reduced-motion settings where practical.

**Tasks**

- **F1.1:** scaffold Electron/React/TypeScript with separate main, preload, and renderer builds; enable a single-instance lock.
- **F1.2:** create companion and chat windows, clamp saved positions, and handle display removal.
- **F1.3:** implement click-versus-drag behavior, hide/show, and an explicit quit option.
- **F1.4:** add character assets and state-driven animations.
- **F1.5:** add a menu-bar/tray fallback or keyboard shortcut so a hidden companion can be restored.
- **F1.6:** ensure quit cancels work, closes owned browser resources, stops timers, and closes the database.

**Acceptance:** the character can be moved and reopened; typing works without trapping focus; another app remains clickable outside companion windows; animations reflect real state. Verify on the demo Mac.

### F2. Text conversation and request routing

**Behavior:** submit text, receive replies, answer clarifications, and ask follow-ups. Do not send screenshots with ordinary text-only questions unless screen context is requested or explicitly enabled for that request.

Use a validated routing result with one of `reply`, `explain_screen`, `highlight_screen`, `flight_search`, or `clarify`. The local application decides which capabilities are available. A model-selected route cannot execute arbitrary functions.

**Tasks**

- **F2.1:** implement messages, pending state, errors, and submit handling; reject empty or over-limit input.
- **F2.2:** persist the user message before dispatching the request.
- **F2.3:** integrate the Anthropic SDK; validate the key, handle authentication, network failures, rate limits, and unavailable models.
- **F2.4:** define and validate routing/response schemas with Zod.
- **F2.5:** reconstruct a bounded recent context from stored messages; distinguish historical text from current instructions.
- **F2.6:** support clarifications linked to the original task; reopening old history never starts execution.
- **F2.7:** persist every user-facing reply and displayed status. MVP responses can appear as complete messages; token streaming is optional.

**Acceptance:** a text request and follow-up work, missing flight details prompt questions, unsupported actions are explained, and failed API calls leave an accurate history entry. API secrets never appear in the UI or logs.

### F3. Configurable Shake to Help

**Behavior:** after explicit opt-in in Settings, a deliberate cursor shake invokes the saved screen-help instruction once. The feature starts disabled. Enabling it authorizes automatic capture and submission of the full cursor display without a per-shake preview; manual Capture screen retains its separate preview flow. Default: “Explain what is happening near my cursor, using the surrounding screen as context.” Save the instruction snapshot used with each gesture request.

**Implemented tuning, subject to device testing:** sample at approximately 30 Hz; retain at most 36 points within 1100 ms; require at least one second of samples and at least four reversals of 24 DIP, 64 DIP of span, 240 DIP of axial travel, and limited net displacement; apply a 3-second cooldown. Reject jitter, long sampling gaps, display crossing, and large pointer warps. Synthetic horizontal/vertical trace fixtures cover these thresholds; the updated one-second threshold has not been test-run; physical mouse/trackpad tuning remains manual acceptance.

The main-process monitor pauses for sleep/lock and suppresses companion drag and native capture. Settings saves reset partial detection. The coordinator persists the instruction and trigger before capture, attaches capture metadata before provider dispatch, records busy declines without a screenshot queue, and uses the existing Stop/deadline/recovery flow. A new gesture conversation opens after capture. Known secrets are redacted from settings/history; movement traces and screenshot bytes are not persisted. See [Phase 4 handoff](Phase-4-Handoff.md).

**Tasks**

- **F3.1:** sample `screen.getCursorScreenPoint()` in the main process and store a bounded movement buffer.
- **F3.2:** implement a pure detector using direction changes, distance, timing, and cooldown.
- **F3.3:** store enabled/disabled and instruction settings; provide reset to default.
- **F3.4:** snapshot trigger position/display, acknowledge immediately, and dispatch through the same request path as chat.
- **F3.5:** suppress repeated activation during a task, character drag, or cooldown; record a declined busy trigger without creating a screenshot queue.
- **F3.6:** pause/reset detection across sleep, wake, and major display changes.

Electron returns cursor positions in device-independent pixels (DIP); use those units consistently in detection. [Screen API](https://www.electronjs.org/docs/latest/api/screen).

**Acceptance:** deliberate mouse and trackpad shakes activate once; normal navigation is unlikely to activate; custom instructions persist across restart; busy triggers cannot launch overlapping tasks.

### F4. Screenshot analysis

**Behavior:** capture the display containing the cursor, then explain relevant content. Single-display capture is the committed MVP. Full active-window identification and arbitrary region selection are extensions, not assumptions about Electron's API.

**Capture sequence:** check existing permission → save cursor/display context → hide companion/chat → wait briefly for the compositor → capture → restore UI → show a local preview → submit the image and prompt only when the user chooses Explain screen. Restore UI in `finally` even if capture fails. Explicit capture restores chat focus; ordinary activation is suppressed during capture.

**Phase 3 implementation:** `src/main/screen/{service,electron-capture}.ts` owns permission/capture and an in-memory single-use image. Source IDs must match the cursor display. Images preserve aspect ratio, are bounded to a 1280-pixel long edge and 4,000,000 JPEG bytes, and expire after 60 seconds. Actual image dimensions and display bounds provide the full-display resize transform; no crop or padding is applied. Only the latest submitted turn receives an image. History stores text and capture metadata, never image bytes. Native capture/preview/discard/expiry checks and all 33 automated tests pass; multi-display/fullscreen and a paid live Claude image response remain acceptance checks. See [Phase 3 handoff](Phase-3-Handoff.md).

**Tasks**

- **F4.1:** implement permission check, capture attempt, and actionable recovery errors.
- **F4.2:** match `desktopCapturer` screen sources to display identifiers; fail clearly if no source can be matched.
- **F4.3:** request a useful image size, inspect actual returned image dimensions, and preserve aspect ratio; do not assume requested thumbnail size equals actual dimensions.
- **F4.4:** create an in-memory capture record with UUID, timestamp, display bounds, image size, scaling/cropping metadata, and cursor coordinates.
- **F4.5:** send the relevant image and question through the vision-capable model adapter; include cursor position in the image's coordinate system.
- **F4.6:** limit image/context size according to the chosen model and current API documentation; release image references after use.
- **F4.7:** save capture metadata and resulting user-facing response, without saving screenshot bytes by default.

Claude's vision API accepts image inputs, but the application must manage sizing and interpretation limits. [Vision documentation](https://platform.claude.com/docs/en/build-with-claude/vision).

**Acceptance:** explanations reference actual visible content; captures exclude Triage's UI in the tested flow; permission denial, unreadable content, or missing sources produce clear failures. No screenshot files are created by default.

### F5. Visual highlighting

**Behavior:** display a temporary ring or rectangle over a target identified from a fresh capture. Phase 5 adds an explicit Show me where to click preview mode and a saved Show me where shake action. A highlight does not click. If location is ambiguous, respond with guidance or ask for a better view.

**Model output and local contract:** ask the model for `{ explanation, target: { x1, y1, x2, y2 } | null }` in absolute image pixels. Enforce the response shape through the SDK's zodOutputFormat and output_config.format. Strictly validate bounds, shape, and finite values locally, then normalize locally to `{ explanation, captureId, target: { x, y, width, height } | null }`. Bind captureId locally to the submitted image. Do not ask the model to invent or echo an opaque capture identity. This follows [Anthropic's coordinate guidance](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates).

For an unpadded full-display image with display DIP bounds `(dx, dy, dw, dh)`, map normalized target coordinates using:

```text
desktopX = dx + x × dw
desktopY = dy + y × dh
desktopWidth = width × dw
desktopHeight = height × dh
overlayLocalX = desktopX − overlayOriginX
overlayLocalY = desktopY − overlayOriginY
```

For crops or letterboxed images, first remove padding and invert the stored crop/resize transform. Do not multiply DIP coordinates by Retina scaling a second time. Use the actual source-image transform as the authority.

**Tasks**

- **F5.1:** define and validate the rectangle schema; reject NaN, out-of-bounds, empty, or impossible targets.
- **F5.2:** implement mapping as pure functions and test Retina, nonzero display origins, and resized images.
- **F5.3:** render a click-through, non-focusable overlay with an explanation in chat.
- **F5.4:** keep highlights visible until the target is clicked or manually dismissed; clear on a new request, task start, or display geometry change.
- **F5.5:** offer dismiss via chat and optionally register Escape only while the highlight is visible.
- **F5.6:** reject stale responses after cancellation or capture replacement. If a managed page navigated, discard its previous highlight.

**Implemented lifecycle:** a separate sandboxed native overlay ignores mouse events and cannot take focus. It waits for a current-frame acknowledgement before showing and stays visible until a target click or dismissal. It also clears across new tasks/captures, Stop, display geometry changes, sleep/lock, and movement of Triage's own windows. A background macOS AppKit observer watches left mouse down/up within the original target without intercepting input. The outline extends six DIP around the target with a thicker border and brighter glow. Click observation stops when the marker clears or the app exits. If observation fails, manual dismissal remains available. This follow-up is compiled; native click acceptance has not been rerun. The native Mac fixture previously verified the menu-bar origin offset fix using enableLargerThanScreen. Capture freshness is limited to 30 seconds and requires the same identity, bounds, display scale, and rotation. If Triage covers the target, save a no-highlight notice rather than mark its controls.

Captures now additionally stay below a 1,000,000-pixel budget while preserving the 1280-pixel long-edge cap. Highlight API requests reject server resizing with transformations.oversized_image=error. Explanations and validated planned-target metadata are saved before native display; images and raw JSON are not stored. See [Phase 5 handoff](Phase-5-Handoff.md) for exact verification.

The MVP cannot reliably detect every scroll or content change in arbitrary external apps. Dismiss and request a fresh capture when content moves; persistent markers do not continuously track their targets.

**Acceptance:** highlights align with known controls in the demo configuration, never consume desktop clicks, and never appear from an old canceled request. Model-based localization accuracy must be tested separately from coordinate-mapping accuracy.

### F6. Alaska Airlines flight-search workflow

**Behavior:** collect details, open the real airline site, enter search fields, submit, verify a results/empty/error state, and leave the page visible. Phase 6 implements this behavior and verified live one-way and round-trip searches on November 10, 2026. The observed English form supports 1–7 adults; unsupported site variants fail without replay. See the [Phase 6 handoff](Phase-6-Handoff.md) for evidence and remaining demo acceptance.

**Workflow input**

```ts
type FlightSearchInput = {
  originAirport: string;
  destinationAirport: string;
  tripType: 'one_way' | 'round_trip';
  departureDate: string; // YYYY-MM-DD, local travel date
  returnDate?: string;
  adults: number;
};
```

The initial form supports adult passengers only. Ask if a request involves children or infants rather than silently converting passenger types. Interpret airports explicitly; “New Jersey” is not itself an airport code. Ask for destination confirmation where necessary. Validate future dates, calendar validity, return ordering, and passenger counts against the site's supported options. Use local calendar dates, not UTC conversions of travel dates.

**Execution design:** Claude extracts intent and missing fields; validated TypeScript code executes a known workflow. This is more bounded than asking a model to invent arbitrary clicks. Prefer accessible roles and labels, inspect autocomplete selections, and verify entered values before search submission.

**Tasks**

- **F6.1:** inspect the live website on the demo network; prove a minimal manual/Playwright search early. Record supported form variants and browser behavior.
- **F6.2:** implement clarification and airport/date/passenger validation.
- **F6.3:** launch headed Chromium with a dedicated profile inside the app data directory; lock against simultaneous contexts using that profile.
- **F6.4:** implement workflow steps for navigation, consent dialogs if encountered, airports, dates, trip type, passenger count, and search.
- **F6.5:** build condition-based waits and per-step timeouts. Do not rely on long fixed sleeps or page `networkidle` as proof of readiness.
- **F6.6:** validate relevant page state after each meaningful interaction; detect results through visible site-specific evidence, not URL change alone.
- **F6.7:** return a structured `results`, `no_results`, `blocked`, or `failed` outcome with observed details and final URL. Distinguish actual empty results from an unfinished page.
- **F6.8:** integrate durable action events and stop checks before every side effect.
- **F6.9:** handle user-closed browser, unexpected navigation, expired page state, and worker failure. Do not bypass verification challenges.
- **F6.10:** keep completed results open until app exit or an explicit browser-close action. A new task uses a new owned page only when the coordinator is idle.

Restrict executable workflows and navigation to the tested airline flow and required destinations. Validate any URL passed to browser launch/open operations; never execute model-generated JavaScript, shell commands, or arbitrary selectors as privileged instructions. Legitimate search submission is authorized by the user's request; bookings and purchases are unsupported.

**Acceptance:** real valid search details reach a verified live result or an accurately reported blocking state. Unsupported routes, dates, or website failures are not reported as success. The task does not enter checkout or payment.

### F7. Status and cancellation

**State model:** `created → planning → waiting_for_user | running → verifying → completed`. From active states allow `stop_requested → stopped`, `failed`, or `paused` when history cannot be written. After an unclean restart, unresolved active states become `interrupted`. Clarification responses resume the existing task rather than duplicate it.

**Tasks**

- **F7.1:** implement a transition validator and a coordinator owning the active task ID.
- **F7.2:** emit brief factual status messages and persist them before display.
- **F7.3:** attach an AbortController to model/network work and a cancellation token to the browser worker protocol.
- **F7.4:** disable new side effects immediately on stop; reject late worker acknowledgments and model results for canceled tasks.
- **F7.5:** bound browser operations. A stop check between awaited calls alone is insufficient for a hung call: after a short grace period, close the task-owned page to interrupt pending operations. If needed, terminate the owned worker, knowing this may close its browser session.
- **F7.6:** record an unknown result for any already-issued action whose effect cannot be verified. Stop is not rollback and cannot retract a submitted search.
- **F7.7:** provide stop in chat and a global emergency shortcut that remains usable while browser focus is active.

**Acceptance:** stop is acknowledged promptly, no subsequent action is authorized, eventual cancellation is bounded, and history identifies the last confirmed action. Browser/UI shutdown cannot leave a runner silently executing.

### F8. Saved conversations and activity history

**Behavior:** automatically retain user-facing conversation and task events locally across restarts. The user can browse by date/title/status, open a transcript and action timeline, and delete individual entries or clear history.

**Tasks**

- **F8.1:** implement schema migrations, foreign keys, indexes, and transactional writes.
- **F8.2:** persist messages, gesture instruction snapshots, status, pending actions, results, failures, confirmations if any, and cancellation events.
- **F8.3:** implement the worker action handshake: persist pending event → acknowledge authorization → execute → persist observed outcome → authorize next step. Never authorize an action if its pre-action event could not be saved.
- **F8.4:** redact known secrets and normalize error payloads before storage; omit full HTML, headers, cookies, credentials, raw SDK responses, screenshots, and hidden model reasoning.
- **F8.5:** build paginated history list and detail views. Reopening history is read-only unless the user explicitly submits a new message.
- **F8.6:** recover active tasks as interrupted at startup; mark unmatched pending actions as outcome unknown, without replaying them.
- **F8.7:** implement deletion with cascade rules. Require stopping an active task before deleting its conversation; do not let new events repopulate an entry mid-deletion.
- **F8.8:** handle write failure as a visible blocking condition for further actions. Maintain a small in-memory error notice if the database itself cannot record the failure.

**Acceptance:** chat-only requests and completed, failed, canceled, and interrupted tasks retain correct messages and event order after restart. Deletion removes the selected logical records. Known key/password fixtures never appear in stored action payloads. An action with unknown outcome is never mislabeled as completed.

## 8. Data model and local storage

Resolve the root using `app.getPath('userData')`; do not hard-code a home-directory path. Keep the app name stable. Expected logical contents:

```text
<userData>/
  history.sqlite
  history.sqlite-wal / history.sqlite-shm  # when WAL is enabled
  settings.json
  credentials.enc
  browser-profile/
```

### 8.1 SQLite entities

- **conversations:** `id`, `title`, `created_at`, `updated_at`.
- **messages:** `id`, `conversation_id`, optional `task_id`, `role`, redacted `content`, `created_at`, and `delivery_state` such as complete or interrupted.
- **tasks:** `id`, `conversation_id`, `kind`, `trigger`, `instruction_snapshot`, `status`, `created_at`, `updated_at`, optional `finished_at`, and redacted `summary`/`error_code`.
- **events:** monotonically increasing `seq` primary key, `id`, `conversation_id`, optional `task_id`, optional `action_id`, `type`, `created_at`, and validated `payload_json`.
- **schema_migrations:** applied schema versions.

Use UTC timestamps for storage and local-time display for history. Use sequence numbers for event ordering, not timestamps alone. Index conversation/update time and task/event order. Maintain foreign-key cascades and parameterized SQL.

Use transactions for each state change plus its associated event. WAL mode and an appropriate durable synchronous setting are reasonable for the local event workload; measure write latency before tuning. Keep raw event payloads small and schema-versioned.

### 8.2 Privacy and deletion semantics

History is plaintext SQLite unless a later encryption feature is implemented. `safeStorage` protects only the key blob. User-visible messages may contain personal information; best-effort redaction cannot guarantee detection of every secret typed into free text. Explain retention during setup and keep diagnostics separate from history.

Deletion removes application-visible records, not a forensic guarantee of secure erasure from SQLite pages, WAL files, backups, or the device. Delete/clear can checkpoint and compact the store when idle, but must not promise irrecoverability. Clearing history does not clear browser cookies or undo information sent to Anthropic; provide a separate reset of the Triage browser profile when no session is open.

No screenshot persistence by default. Temporary browser screenshots used for debugging must be opt-in, excluded from commits, and removable. No telemetry or cloud synchronization in the MVP.

## 9. IPC and worker contracts

Use a narrow `window.triage` API through `contextBridge`; renderer code never chooses raw IPC channels. Keep `contextIsolation` enabled, Node integration disabled, and renderer sandboxing enabled. Validate the sender, origin, and payload on every privileged request. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

Example application contract:

```ts
interface TriageBridge {
  sendMessage(input: { conversationId?: string; text: string }): Promise<{ taskId: string }>;
  stopTask(taskId: string): Promise<void>;
  getSettings(): Promise<PublicSettings>;
  updateSettings(input: PublicSettingsPatch): Promise<void>;
  setApiKey(key: string): Promise<{ configured: boolean }>;
  listHistory(input: { cursor?: number; limit: number }): Promise<HistoryPage>;
  getHistoryEntry(conversationId: string): Promise<HistoryEntry>;
  deleteHistoryEntry(conversationId: string): Promise<void>;
  clearHistory(): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
```

`PublicSettings` contains gesture options, character position, model identifier, and key-configured status, never the decrypted key. Type declarations are supplemented by runtime Zod validation and size limits. Event subscriptions return cleanup functions to avoid duplicate listeners during React rerenders.

Worker protocol messages include `start`, `cancel`, `action_proposed`, `action_authorized`, `action_result`, `workflow_result`, and `worker_error`. Each includes a task ID; action messages include a unique action ID. The coordinator rejects stale, duplicate, unrecognized, or canceled action requests and only acknowledges after a successful database commit.

## 10. Model integration and execution limits

Use the SDK directly; a general agent framework is unnecessary for this bounded MVP. Define typed tools or structured response schemas and validate outputs locally. Claude tool use lets the model request application-defined operations; execution remains application-owned. [Tool-use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview).

System instructions should state available capabilities, require clarification of missing travel details, treat webpage text as untrusted content, and prohibit claiming success without an observed result. Screenshots can contain instructions planted by websites; those instructions must not expand tool permissions or override the user's goal.

Starting limits: one active task, bounded recent message context, one screenshot per screen request, a small finite model-call budget per task, and one schema-repair attempt after invalid output. Set explicit API and workflow deadlines. Tune these limits during testing rather than silently allowing indefinite loops.

Do not blindly retry non-idempotent actions. Recheck the page before retrying form submission, and never rerun a task automatically after a crash. Store usage metadata when supplied by the SDK, without storing raw response bodies or promising exact cost figures.

## 11. Failure behavior

- **Missing key:** explain setup requirements; leave history and settings usable.
- **Invalid key/model or API/network failure:** save a normalized failure and provide an explicit retry option.
- **Screen permission denied:** keep text interaction usable, explain how to enable capture, and do not send a blank image as though it were valid.
- **Unclear screen or target:** ask for clarification or provide text guidance; do not fabricate a highlight.
- **Website changed/verification challenge:** stop and report the observed obstacle. No stealth or challenge-bypass mechanism.
- **Browser closed or worker crashed:** terminate task state accurately; never silently reopen and replay a partially completed search.
- **History write failure:** disable subsequent automated actions, display the issue, and preserve the current task as paused where persistence permits.
- **Late result after stop:** discard it for execution; retain only appropriate canceled-request metadata.
- **Sleep, display change, or app quit:** reset gestures, clear overlays, cancel current work, and mark unresolved work interrupted on recovery.

## 12. Development and local execution

At setup, choose exact dependency versions and record them in the lockfile. Align development Node with electron-vite requirements; remember that Electron has its own embedded Node version.

Define these project scripts as implementation deliverables (some belong to later phases):

```text
npm ci                   Install locked dependencies
npm run browser:install  Install the Playwright Chromium matching the pinned package
npm run dev              Start Electron and the React development build together
npm run typecheck        Check main, preload, worker, renderer, and shared contracts
npm run lint             Check source conventions
npm test                 Run meaningful unit and persistence tests
npm run test:browser     Run controlled browser workflow fixtures
npm run build            Compile main/preload/worker and renderer assets
```

The current repository provides `dev`, `browser:install`, `typecheck`, `test`, `build`, and `start`. The remaining specialized script names above are proposed; `npm test` currently includes the controlled browser fixtures. Native Phase 6 acceptance is explicitly invoked with `node scripts/check-native-browser.mjs` after a build. Tests and live automation require owner authorization under AGENTS.md. The browser installation script should wrap the pinned Playwright CLI. Ensure worker entry paths resolve in both development and compiled builds; keep native modules external to the bundler as required by the toolchain.

First run: initialize schema → recover interrupted tasks → load settings → verify credential availability → show setup → test capture permission → launch companion. Prove database writes, Chromium launch, and a Claude image response on the demo Mac before polishing animations.

## 13. Build milestones and ownership

No team size or duration has been supplied, so these are dependency-based milestones, not guaranteed hour estimates. Split work among people only after contracts are agreed.

### M0. Integration risks proven

Complete F1.1, a native SQLite smoke test, credential/session-key setup, a real screen capture, a Claude image response, and F6.1. **Exit:** the actual demo Mac can run every essential external dependency. If airline automation is blocked, resolve or explicitly revise the flagship workflow before investing heavily in UI polish.

### M1. Persistent conversational companion

Complete F1, the core of F2, F8 schema and message persistence, and minimal task states. **Exit:** ask a question, get a reply, restart, and review it.

### M2. Screen-help experience

Complete F3, F4, and F5; integrate event history. **Exit:** shake, get a relevant explanation, ask for a highlight, and see accurate screen placement.

### M3. Browser action experience

Complete F6 and F7 with the worker acknowledgment protocol. **Exit:** clarification, real form search, verified result, progress, and stop behavior all work.

### M4. Review and demo readiness

Complete history UI/deletion, interruption recovery, permission recovery, and macOS smoke tests. **Exit:** demonstrate all eight features from a clean launch using known valid travel details and a truthful failure path.

Suggested ownership streams are desktop UI, model/screen features, browser workflow, and persistence/coordinator. For a smaller team, combine streams. Shared contracts, cancellation, and history integration require joint attention throughout; do not defer them to final assembly.

## 14. Verification plan

### Automated checks with meaningful coverage

- **Gesture logic:** deliberate shake, normal movement, jitter, cooldown, and busy suppression using recorded coordinate traces.
- **Coordinates:** round-trip image/display transforms, Retina scaling, bounds rejection, crop/resize metadata, and stale capture rejection.
- **State/cancellation:** legal transitions, waiting-for-user resume, cancellation races, and rejection of late action authorization.
- **History:** write-before-action acknowledgment, crash recovery with unknown outcomes, transactional event order, deletion cascades, and write-failure blocking.
- **Secrets:** fixture keys/tokens excluded from stored payloads and diagnostics; public settings never return secrets.
- **Workflow fixtures:** autocomplete, date picker, delayed results, no results, changed selectors, and verification/blocked states against a controlled local page. Fixtures test mechanics; they do not establish live-site compatibility.

### Real macOS checks

Test the exact demo machine and launch method for permission denial/grant/restart, character focus, click-through overlay, Retina alignment, hide-before-capture behavior, normal cursor activity, visible Chromium launch, and API connectivity.

Run a live airline search early and again before the demo when justified by integration changes or website behavior. Verify one cancellation during a wait, one after a form action, and one app restart with an unfinished task. Keep live tests deliberate rather than running them repeatedly in a loop.

Suggested responsiveness targets: acknowledge gestures and stop requests within 250 ms under normal local load, keep the interface usable during network waits, and prevent new action authorization immediately after stop. Measure end-to-end cancellation and set a small bounded grace period, initially 2 seconds before closing the task page. These are targets to validate, not guarantees about third-party APIs or websites.

## 15. Definition of done

The MVP is ready when all of the following are demonstrated on macOS:

- A local development command opens a movable animated companion and working text chat.
- Shake invokes the saved instruction once and captures the intended display.
- Screen explanations use actual visible content; highlights align in the tested Retina configuration.
- Triage collects missing flight details and reaches a verified search outcome in its own visible browser.
- Progress reflects real stages; stop prevents subsequent actions and reports uncertain in-flight outcomes honestly.
- Conversations and action events survive restart, show interrupted work accurately, and can be reviewed and deleted.
- API keys stay outside renderer state and history; screenshot bytes are not retained by default.
- Required checks pass, limitations are documented, and no unsupported capability is presented as complete.

## 16. Decisions to confirm during kickoff

These do not change the proposed architecture, but the team should record the answers before implementation proceeds far:

1. Exact demo Mac, OS version, architecture, display arrangement, and launch method.
2. Available Claude model and key, plus request limits suitable for the demo budget.
3. Whether bundled Chromium can complete the airline flow or installed Chrome is required.
4. Actual live-site airport/date/passenger controls, result selectors, and required domains.
5. Character assets and animation format.
6. Whether a local `.app` build is needed for stable permission/credential behavior.

Installer distribution, broad browser support, native desktop automation, and additional features remain separate future milestones.
