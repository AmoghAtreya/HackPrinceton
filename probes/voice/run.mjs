// Explicitly run this probe only with owner authorization. No production imports.
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const mode = process.argv[2] ?? 'inspect'
if (!['inspect', 'idle', 'keys', 'microphone', 'playback', 'build'].includes(mode)) {
  throw new Error('Use build, inspect, idle, keys, microphone, or playback.')
}
if (process.platform !== 'darwin') throw new Error('This probe requires macOS.')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = join(root, 'release', 'TriageVoiceProbe.app')
const contents = join(bundle, 'Contents')
const executable = join(contents, 'MacOS', 'TriageVoiceProbe')
const entitlements = join(root, 'release', 'voice-probe-entitlements.plist')
function run(command, args, timeout = 180000) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout })
  if (result.error) throw result.error
  if (result.signal) throw new Error(command + ' terminated by ' + result.signal + '; native execution may require an unsandboxed terminal.')
  if (result.status !== 0) process.exit(result.status ?? 1)
}
mkdirSync(dirname(executable), { recursive: true })
writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.triage.voice-feasibility.local</string>
<key>CFBundleName</key><string>Triage Voice Probe</string>
<key>CFBundleExecutable</key><string>TriageVoiceProbe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Explicit four-second voice feasibility check. Audio and transcripts are not saved.</string>
<key>NSSpeechRecognitionUsageDescription</key><string>Check English on-device recognition only. No server fallback is allowed.</string>
</dict></plist>\n`)
writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>\n`)
run('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macosx14.0',
  '-module-cache-path', join(root, 'release', 'voice-module-cache'),
  join(root, 'probes', 'voice', 'Feasibility.swift'), '-o', executable])
run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, bundle])
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
console.log('Built and verified isolated arm64 probe: ' + bundle)
if (mode !== 'build') {
  // Launch Services makes privacy prompts belong to this app, not the shell host.
  const temporary = mkdtempSync(join(tmpdir(), 'triage-voice-probe-'))
  try {
    const output = join(temporary, 'result.jsonl')
    run('/usr/bin/open', ['-n', '-W', '--stdout', output, '--stderr', '/dev/null', bundle, '--args', mode, ...(process.argv.includes('--switch-focus') ? ['--switch-focus'] : [])], 105000)
    const result = readFileSync(output, 'utf8')
    process.stdout.write(result)
    const events = result.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const expected = { inspect: 'capabilities', idle: 'idle', keys: 'keysFinished',
      microphone: 'captureStopped', playback: 'playbackCancelled' }[mode]
    if (!events.some((event) => event.probe === expected)) throw new Error('Native probe did not complete: ' + mode)
    const last = events.findLast((event) => event.probe === expected)
    if (mode === 'microphone' && (!last.final || !last.recognizedNonempty || last.recognitionError || last.engineRunning)) {
      throw new Error('Capture closed, but local transcription acceptance did not pass.')
    }
    if (mode === 'keys') {
      const release = events.filter((event) => event.probe === 'release')
      const pressed = events.filter((event) => event.probe === 'activation')
      if (!release.some((event) => event.reason === 'spaceUp') ||
          !release.some((event) => event.reason === 'modifierUp') ||
          !release.some((event) => event.foregroundChangedDuringHold) ||
          !pressed.some((event) => event.otherAppForeground && event.chordCurrentlyDown) ||
          events.some((event) => event.probe === 'releaseWatcherInvalidated') ||
          release.some((event) => event.reason === 'probeShutdown')) {
        throw new Error('Shortcut release acceptance is incomplete; exercise Space release, modifier release, and a focus change during a hold.')
      }
    }
    if (mode === 'playback' && (!last.wasSpeaking || !last.cancelAccepted || last.speaking || last.engineRunning)) {
      throw new Error('Local playback cancellation did not pass.')
    }
    if (mode === 'idle' && (last.engineRunning || last.cpuPercentOneCore > 1)) {
      throw new Error('Short idle probe exceeded the preliminary CPU/stream budget.')
    }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
