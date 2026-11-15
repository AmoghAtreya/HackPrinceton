# Spoken replies (Amazon Polly)

Triage reads its answers aloud in a slow, clear neural voice. If Polly is unavailable, the Mac's built-in voice takes over, so Triage never goes silent.

## What the user gets

- **Automatic reading.** By default, replies are read aloud when you asked by voice or with Shake to Help. Settings → Voice replies → "Read replies aloud" can be changed to **Always** (typed questions too) or **Never**.
- **Short version.** Triage reads the first one to three sentences (about 300 characters), then says "The rest is on screen." Links and formatting are skipped.
- **Failures are spoken too.** A failed request is read as "Sorry, that didn't work. …". A request you stopped yourself stays silent.
- **Stopping it.** Speech stops instantly when you:
  - press the talk button (before the mic opens, so Triage never hears itself),
  - say "stop",
  - click **Stop** next to "Speaking…",
  - start a new conversation.
- **Replay.** **Say that again** replays the last reply from cached audio, without calling Polly again. Every Triage message also has a **Read aloud** button.
- **Settings.** Voice: Joanna, Matthew, Ruth or Stephen (US English, neural). Speed: Slower (80%), Relaxed (90%, the default), Normal (100%) or Faster (115%). **Test voice** saves your choices and plays a sample.

## Setup

Polly uses the same AWS credentials as Transcribe (see [Voice-Transcribe.md](Voice-Transcribe.md)). The IAM identity also needs `polly:SynthesizeSpeech`:

```json
{ "Effect": "Allow", "Action": ["transcribe:StartStreamTranscription", "polly:SynthesizeSpeech"], "Resource": "*" }
```

- **Region:** `AWS_REGION` (default `us-east-1`). Set `TRIAGE_POLLY_REGION` to use a different region for Polly only.
- **Voice engine:** neural voices are tried first. If the region doesn't offer them (for example `us-east-2`), Triage switches to **standard** voices for the rest of the session, with Matthew standing in for Stephen and Joanna for Ruth. Set `TRIAGE_POLLY_ENGINE=standard` to skip the neural attempt.
- **New AWS accounts on the Free plan** may block Transcribe and limit Polly through an organization-level policy (error: "explicit deny in a service control policy"). Upgrading the account to the paid plan removes the block; giving your IAM user more permissions does not.
- **Cost:** neural voices cost about $16 per million characters. A reply is about 300 characters, so roughly $0.005 each.

## Flow

```
AssistantPanel (renderer)
  deliver() / shake gesture → remember the task id if it should be spoken
  reply arrives → prepareSpeech(reply)                (src/shared/speech-text.ts)
  → speechPlayer.speak(text)                          (src/renderer/src/voice/speech-player.ts)
       └ synthesizeSpeech(text) ──IPC──▶ PollyService.synthesize   (src/main/speech/polly.ts)
                                          SSML <speak><prosody rate="90%">…</prosody></speak>
                                          neural · mp3 · 24 kHz · last 20 cached
       ◀── mp3 bytes ───────────────────
       AudioContext.decodeAudioData → play
       on any error → speechSynthesis (macOS voice) + a one-time notice explaining why
```

- **The renderer decides what to speak; the main process only synthesizes.** The renderer knows which request came from voice, a shake or typing. The main process holds the AWS credentials and checks the input (1 to 1,500 characters).
- **Settings file:** `<userData>/speech-settings.json` (`src/main/speech/settings.ts`).
- **No audio is saved to disk.** It is only kept in memory for replay.

## Files

- `src/shared/speech-contracts.ts`: settings types, defaults, voices, IPC channels
- `src/shared/speech-text.ts`: `prepareSpeech` and `failureSpeech`
- `src/main/aws/config.ts`: the region lookup shared with Transcribe
- `src/main/speech/polly.ts`, `settings.ts`, `ipc.ts`: synthesis, settings and IPC
- `src/renderer/src/voice/speech-player.ts`: playback, the fallback voice, replay
- `src/renderer/src/SpeechSettingsPanel.tsx`: the Settings section
- `AssistantPanel.tsx` and `VoiceButton.tsx`: automatic reading, Read aloud, Stop and Say that again

## Not verified yet

- None of this has been run against live Polly or in the app. There are no AWS credentials on the dev Mac yet.
- Playback while the chat window is hidden (for example a reply to a shake) is expected to work, but hasn't been checked.

## Later

- Polly speech marks, to sync spoken steps with on-screen arrows.
- Speaking while Triage works ("One moment…").
- Non-English voices.
