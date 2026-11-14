# Voice input (Amazon Transcribe)

The chat window has a **Hold to talk** button. Hold it while speaking and let go to stop. A quick tap starts recording, and a second tap stops it. Esc cancels. Live captions appear as you speak. When you stop, the finished transcript is saved locally and handed to the chatbot (see [Voice commands](#voice-commands)).

## Setup

Triage uses the AWS SDK's default credential chain **in the main process only**. The renderer never sees AWS keys.

```bash
# any one of these
export AWS_PROFILE=hackprinceton
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... # (+ AWS_SESSION_TOKEN)

export AWS_REGION=us-east-1                 # optional, default us-east-1
export TRIAGE_TRANSCRIBE_LANGUAGE=en-US     # optional, default en-US
npm run dev
```

The IAM identity needs `transcribe:StartStreamTranscription`. Spoken replies also need `polly:SynthesizeSpeech`; see [Speech-Polly.md](Speech-Polly.md).

macOS asks for microphone access the first time you press the button. In development, the request is attributed to Electron (or to the terminal that launched it).

## Flow

```
Chat renderer                                   Main process
─────────────                                   ────────────
VoiceButton ──startVoice()──────────────────▶ VoiceController.start()
                                                  ├ ensureMicrophoneAccess()  (macOS TCC)
                                                  └ TranscribeService.verifyCredentials()
MicrophoneCapture
  getUserMedia → AudioContext(16 kHz)
  → pcm-worklet.js (Float32 → Int16, 100 ms)
  ──sendVoiceAudio(id, chunk)───────────────▶ AudioQueue ──▶ StartStreamTranscription (WebSocket/HTTP2)
                                                                    │
  ◀──voice:utterance {user_utterance}──────── VoiceController ◀─────┘ partial + final results
  ◀──voice:state {speech_state}───────────────
VoiceButton ──finishVoice(id)───────────────▶ end audio, wait for last final (≤10 s)
                                                  ├ TranscriptStore.save(record)
                                                  └ emit { type: 'transcript', record }
```

At most one recording runs at a time. A recording ends itself after 60 s, and the renderer stops its microphone when it sees the state leave `listening`. Sleep or screen lock drops the recording without storing it.

## Message contract (`src/shared/voice-contracts.ts`)

| Direction | Message |
|---|---|
| Voice → UI | `{ type: 'speech_state', state: 'idle' \| 'listening' \| 'thinking' \| 'speaking', sessionId, error? }` |
| Voice → agent/UI | `{ type: 'user_utterance', sessionId, segmentId, text, isFinal, confidence, timestamp }` |
| Voice → agent | `{ type: 'transcript', record: TranscriptRecord }` (main-process only) |

Partial results for the same `segmentId` are replaced by later ones. `confidence` is the mean word confidence of a final segment. `speaking` is not emitted by the main process; the chat window's speech player tracks playback itself (see [Speech-Polly.md](Speech-Polly.md)).

## Storage

`TranscriptStore` (`src/main/voice/transcript-store.ts`). The default implementation is `LocalTranscriptStore`, which appends one JSON line per recording to `<userData>/voice-transcripts.jsonl` (on macOS: `~/Library/Application Support/triage/`). The file is unencrypted, with mode 0600. Recordings with no recognized text and cancelled recordings are not stored. A DynamoDB store can implement the same two-method interface.

## Voice commands

Finished transcripts are handled in the chat window (`handleTranscript` in `src/renderer/src/AssistantPanel.tsx`), not in the main process. The chat window already knows the open conversation, any waiting screenshot, the "Show me where" setting, and whether a reply is running. Spoken messages go through the same `sendMessage` call as typed ones, with `source: 'voice'`, so history shows them as "You · voice".

Order of handling:

1. **Local shortcuts** (`src/renderer/src/voice/intents.ts`). These never reach the model. Stop and new-conversation only match the whole utterance, so "stop my subscription" still goes to the chatbot.

   | Say | Does |
   |---|---|
   | "stop", "cancel that", "never mind" | Stops the running request (works while busy), or discards a waiting screenshot |
   | "start over", "new conversation" | Starts a new conversation |
   | "what's on my screen", "explain this page", "what does this say" | Captures the screen (or uses the waiting one) and explains it |
   | "show me where…", "where's the…", "where do I click…", "highlight the…" | Captures the screen and points at the control |

2. **Review instead of sending.** The transcript goes into the message box with a notice, and isn't sent, when:
   - a request is already running, or
   - the transcript is one word, or
   - the mean word confidence is below `VOICE_CONFIDENCE_THRESHOLD` (0.6). Shortcuts skip this check.

   Spoken text is appended after any typed draft.

3. **Everything else** is sent to the chatbot as is. The chatbot decides between a normal reply and the Alaska flight search.

The main-process `voice.subscribe(...)` hook in `src/main/index.ts` still receives every voice event. It's for logging and, later, for Polly spoken replies, not for sending messages.

## Files

- `src/shared/voice-contracts.ts`: types, channels, limits
- `src/main/voice/transcribe.ts`: Transcribe client, result parsing, AWS error messages
- `src/main/voice/audio-queue.ts`: IPC push → SDK async-iterable pull
- `src/main/voice/controller.ts`: session lifecycle, events, storage
- `src/main/voice/transcript-store.ts`: storage interface and local JSONL store
- `src/main/voice/ipc.ts`, `src/main/voice/microphone.ts`: IPC and the macOS mic permission
- `src/renderer/public/pcm-worklet.js`, `src/renderer/src/voice/microphone.ts`: capture
- `src/renderer/src/VoiceButton.tsx`: UI
- `src/renderer/src/voice/intents.ts`: voice shortcuts and the review rule

## Not yet verified

- None of this has been run against live AWS or a real microphone.
- `scripts/prepare-local-app.mjs` has not been tried with the AWS SDK's dependency tree. It rejects duplicate package versions.
