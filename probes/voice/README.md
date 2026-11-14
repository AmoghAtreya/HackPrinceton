# Isolated macOS voice feasibility probe

This is Phase 8 tooling, not Triage voice integration. It imports no Triage code, reads no app profile or credentials, sends no assistant/browser request, and writes no audio or transcript. Its stdout contains capability flags, chord event reasons, CPU timing and result booleans only. Generated apps, module caches and signing files stay under ignored `release/`; never commit those artifacts, native logs, crash reports or permission data.

Native checks require owner authorization under the repository's AGENTS.md. Authorization was granted for the Phase 8 session; that is not standing permission for future sessions. Requires an Apple Silicon Mac and Command Line Tools with Swift. The current probe targets macOS 14+; that is a build target, not certification of every OS version.

## Build and run

From the repository root:

```sh
node probes/voice/run.mjs build
node probes/voice/run.mjs inspect
node probes/voice/run.mjs idle
node probes/voice/run.mjs playback
node probes/voice/run.mjs keys
node probes/voice/run.mjs microphone
```

Each command builds and verifies an ad-hoc Hardened Runtime `release/TriageVoiceProbe.app`. The app has its own identity (`com.triage.voice-feasibility.local`), usage descriptions and audio-input entitlement. The runner launches it through macOS Launch Services, reads only its structured stdout, checks evidence and deletes temporary output. Native stderr is discarded by the runner. Main Triage need not be running. The status panel is non-activating, temporary and ignores mouse clicks so another app can remain in front.

Do not run its internal executable directly for permission tests: authorization may instead be attributed to the invoking shell's responsible application, and a missing host usage description can terminate the process. The first implementation exposed this difference. Development, this isolated probe and packaged Triage have separate grants; one does not certify another. Recompiling/re-signing changed ad-hoc code can require renewed grants. Build changes before granting permissions; do not reset TCC or change OS privacy settings programmatically.

- `inspect`: capability/authorization snapshot; does not request permission or open audio input. `onDeviceRecognition: true` is necessary, not proof of successful transcription.
- `idle`: ten seconds with recognizer metadata initialized, no input node/tap created and no engine started. Emits process CPU time; this is a short feasibility measurement, not the five-minute full helper acceptance. Use authorized `/usr/bin/time -l` around the launched app executable for process resident-memory measurement **only for this non-prompting mode**.
- `playback`: starts a fixed local phrase, stops it after 300 ms, and verifies speaking stopped while the input engine stayed off. It may briefly play sound.
- `keys`: requests Input Monitoring if needed and waits up to 45 seconds. macOS may require a quit/reopen after granting. Then runs a visible 45-second check. Keep another app in front. Hold Control (⌃) + Option (⌥) + Space and release Space; repeat releasing Option first; then hold, click another app while still holding, and release. No Accessibility automation is used. Do not count `startupReconciliation`, `probeShutdown` or watcher invalidation as successful release delivery. The runner requires actual Space-up, modifier-up, foreground-app activation and a foreground change during a hold. Exclusive registration deliberately rejects a duplicate with `-9878`.
- `microphone`: requests Speech Recognition and Microphone permissions. After approval the panel gives a three-second lead-in, then says Listening. Say “Triage voice check” during its four-second capture. Audio stops before a maximum three-second finalization wait. The request requires on-device recognition, with no server fallback. Only final/nonempty/error flags and numeric error code are reported; transcript and audio stay in memory and are discarded on exit. An empty or failed recognition is a failed check even when cleanup succeeded.

The application-side capture bound starts after permission approval; permission setup waits up to 45 seconds. The runner's launch timeout covers setup plus the bounded check. Missing completion events are failures, since Launch Services' exit status alone does not establish the app's acceptance result.

## Interpretation and limits

Read [the Phase 8 decisions](../../docs/Voice-Implementation-Decisions.md) and [handoff](../../docs/Phase-8-Handoff.md) for the decision and recorded results. The probe does not implement the production helper transport, session coordinator, watchdog, task reservation, settings, transcript panel or conversation ownership. It does not dispatch on either partial or final transcripts. Lock/sleep, device loss, revoked permissions, nested production helper identity, Developer ID/notarization, offline end-to-end recognition, full performance percentiles and all Phase 9–14 acceptance remain distinct checks.
