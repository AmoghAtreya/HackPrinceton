import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const helper = join(root, 'release', 'TriageVoiceHelper.app')
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || command + ' failed')
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Voice currently requires Apple Silicon macOS 14+.')
mkdirSync(join(helper, 'Contents', 'MacOS'), { recursive: true })
mkdirSync(join(root, 'release', 'voice-module-cache'), { recursive: true })
writeFileSync(join(helper, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.triage.desktop.voice-helper.local</string>
<key>CFBundleExecutable</key><string>TriageVoiceHelper</string>
<key>CFBundleName</key><string>Triage Voice Helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Triage records only when you explicitly start voice input, and releases the microphone when you finish or cancel.</string>
<key>NSSpeechRecognitionUsageDescription</key><string>Triage transcribes your explicitly started voice input on this Mac. Recognition that requires a server is rejected.</string>
</dict></plist>\n`)
const entitlements = join(root, 'release', 'voice-helper-entitlements.plist')
writeFileSync(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>\n')
run('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macosx14.0', '-module-cache-path', join(root, 'release', 'voice-module-cache'),
  join(root, 'native/voice/VoiceHelper.swift'), '-o', join(helper, 'Contents/MacOS/TriageVoiceHelper')])
run('/usr/bin/codesign', ['--force', '--options', 'runtime', '--entitlements', entitlements, '--sign', '-', helper])
run('/usr/bin/codesign', ['--verify', '--strict', helper])
console.log('Built local voice helper. No microphone or permission prompt was opened.')
