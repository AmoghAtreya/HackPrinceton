// Builds release/TriageSpeechHelper.app: Triage's free, on-device speech recognizer.
// It is its own app bundle so macOS attributes the Speech Recognition permission
// to "Triage Speech" rather than to whichever process launched it.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

if (process.platform !== 'darwin') throw new Error('The on-device speech helper requires macOS.')
const root = fileURLToPath(new URL('../', import.meta.url))
const app = join(root, 'release', 'TriageSpeechHelper.app')
const executable = join(app, 'Contents', 'MacOS', 'TriageSpeechHelper')
const moduleCache = join(root, 'release', 'speech-module-cache')

rmSync(app, { recursive: true, force: true })
mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
mkdirSync(moduleCache, { recursive: true })
writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.triage.speech-helper.local</string>
<key>CFBundleExecutable</key><string>TriageSpeechHelper</string>
<key>CFBundleName</key><string>Triage Speech</string>
<key>CFBundleDisplayName</key><string>Triage Speech</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSSpeechRecognitionUsageDescription</key><string>Triage turns what you say into text on this Mac, only while you hold or tap the talk button. Audio never leaves this Mac.</string>
</dict></plist>
`)
execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
  '-module-cache-path', moduleCache, join(root, 'native', 'speech', 'TriageSpeechHelper.swift'), '-o', executable], { stdio: 'inherit' })
execFileSync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--sign', '-', app], { stdio: 'inherit' })
execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'inherit' })
console.log('Built ' + app)
