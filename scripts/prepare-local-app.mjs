import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = join(root, 'release', 'Triage.app')
const staging = join(root, 'release', 'Triage-staging.app')
const scanner = join(root, 'release', 'TriageLinkScanner.node')
const contextModule = join(root, 'release', 'TriageContextSnapshot.node')
const runtime = join(root, 'node_modules', 'electron', 'dist', 'Electron.app')

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || command + ' failed')
}

if (process.platform !== 'darwin') throw new Error('This local app preparation script requires macOS.')
for (const path of [runtime, join(root, 'out', 'main', 'index.js'), join(root, 'out', 'preload', 'index.js'), join(root, 'out', 'renderer', 'index.html')]) {
  if (!existsSync(path)) throw new Error('Missing ' + path + '. Install dependencies and run npm run build first.')
}

if (!existsSync(scanner)) throw new Error('Missing ' + scanner + '. Run npm run phishing:build first.')
if (!existsSync(contextModule)) throw new Error('Missing ' + contextModule + '. Run npm run context:build first.')

// Only generated bundles and installed runtime packages enter the app. Never copy
// the repository, settings, local profiles, environment files, or user data.
mkdirSync(dirname(destination), { recursive: true })
if (existsSync(staging)) throw new Error('A staging app already exists. Finish or remove that generated staging app before rebuilding.')
try {
  run('/usr/bin/ditto', [runtime, staging])
  const resources = join(staging, 'Contents', 'Resources')
  rmSync(join(resources, 'default_app.asar'), { force: true })
  const bundledScanner = join(staging, 'Contents', 'Helpers', 'TriageLinkScanner.node')
  mkdirSync(dirname(bundledScanner), { recursive: true })
  cpSync(scanner, bundledScanner)
  run('/usr/bin/codesign', ['--force', '--sign', '-', bundledScanner])
  run('/usr/bin/codesign', ['--verify', '--strict', bundledScanner])
  const bundledContext = join(staging, 'Contents', 'Helpers', 'TriageContextSnapshot.node')
  cpSync(contextModule, bundledContext)
  run('/usr/bin/codesign', ['--force', '--sign', '-', bundledContext])
  run('/usr/bin/codesign', ['--verify', '--strict', bundledContext])
  // Free on-device speech recognition helper (npm run speech:build). It keeps its own
  // bundle identity so macOS asks for Speech Recognition permission for "Triage Speech".
  const speechHelper = join(root, 'release', 'TriageSpeechHelper.app')
  if (existsSync(speechHelper)) {
    const bundledSpeech = join(staging, 'Contents', 'Helpers', 'TriageSpeechHelper.app')
    cpSync(speechHelper, bundledSpeech, { recursive: true })
    run('/usr/bin/codesign', ['--verify', '--strict', bundledSpeech])
  } else console.warn('No speech helper found; run npm run speech:build to include free voice input.')
  const appRoot = join(resources, 'app')
  mkdirSync(appRoot, { recursive: true })
  cpSync(join(root, 'out'), join(appRoot, 'out'), { recursive: true })
  const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({
    name: 'triage', productName: 'Triage', version: project.version,
    main: 'out/main/index.js', private: true
  }, null, 2) + '\n')

  const copied = new Map()
  function copyPackage(name, from) {
    const require = createRequire(join(from, 'package.json'))
    let entry
    try { entry = require.resolve(name + '/package.json') }
    catch { entry = require.resolve(name) }
    let directory = dirname(realpathSync(entry))
    while (true) {
      const manifest = join(directory, 'package.json')
      if (existsSync(manifest)) {
        const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
        if (metadata.name === name) {
          // A version nested in another package's own node_modules (e.g.
          // @langchain/langgraph-sdk/node_modules/p-queue) was already copied
          // with that parent folder; only its dependencies still need copying.
          const topLevel = join(root, 'node_modules', name)
          if (directory !== (existsSync(topLevel) ? realpathSync(topLevel) : topLevel) && directory.includes(join('node_modules', name.split('/')[0]))) {
            const nestedKey = 'nested:' + directory
            if (copied.has(nestedKey)) return
            copied.set(nestedKey, directory)
            for (const dependency of Object.keys(metadata.dependencies ?? {})) copyPackage(dependency, directory)
            return
          }
          if (copied.has(name)) {
            if (copied.get(name) !== directory) throw new Error('Multiple versions of ' + name + ' need explicit packaging support.')
            return
          }
          copied.set(name, directory)
          cpSync(directory, join(appRoot, 'node_modules', name), { recursive: true })
          for (const dependency of Object.keys(metadata.dependencies ?? {})) copyPackage(dependency, directory)
          for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
            try { require.resolve(dependency) } catch { continue }
            copyPackage(dependency, directory)
          }
          return
        }
      }
      const parent = dirname(directory)
      if (parent === directory) throw new Error('Could not locate package metadata for ' + name)
      directory = parent
    }
  }
  // Electron is already supplied by the app bundle copied above.
  for (const name of Object.keys(project.dependencies)) {
    if (name !== 'electron') copyPackage(name, root)
  }

  const plist = join(staging, 'Contents', 'Info.plist')
  for (const [key, value] of Object.entries({
    CFBundleIdentifier: 'com.triage.desktop.local', CFBundleName: 'Triage',
    CFBundleDisplayName: 'Triage', CFBundleVersion: project.version,
    CFBundleShortVersionString: project.version
  })) run('/usr/libexec/PlistBuddy', ['-c', 'Set :' + key + ' ' + value, plist])
  // Re-sign the local Electron runtime inside out. Some npm Electron distributions
  // carry incomplete framework resource signatures; outer signing cannot repair them.
  // Keep any Electron entitlements.
  function signRuntime(path) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) signRuntime(join(path, name))
      if (/\.(app|framework|xpc)$/.test(path))
        run('/usr/bin/codesign', ['--force', '--preserve-metadata=entitlements', '--sign', '-', path])
    } else if (stat.isFile()) {
      const header = Buffer.alloc(4)
      const fd = openSync(path, 'r')
      try { readSync(fd, header, 0, 4, 0) } finally { closeSync(fd) }
      if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(header.readUInt32BE()))
        run('/usr/bin/codesign', ['--force', '--preserve-metadata=entitlements', '--sign', '-', path])
    }
  }
  signRuntime(join(staging, 'Contents', 'Frameworks'))
  // macOS requires a usage description before any app may open the microphone.
  const micKey = 'NSMicrophoneUsageDescription'
  const micText = 'Triage listens only while you hold or tap the talk button, and sends that audio to Amazon Transcribe to write down what you said.'
  const micPresent = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + micKey, plist], { encoding: 'utf8' }).status === 0
  run('/usr/libexec/PlistBuddy', ['-c', (micPresent ? 'Set :' + micKey + ' ' : 'Add :' + micKey + ' string ') + micText, plist])
  run('/usr/bin/codesign', ['--force', '--sign', '-', staging])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staging])
  // Replacing this generated app never removes application user data.
  rmSync(destination, { recursive: true, force: true })
  renameSync(staging, destination)
  console.log('Prepared local app: ' + destination)
  console.log('Quit any terminal-launched Triage first, then open this app directly from Finder.')
  console.log('Add this exact Triage.app in macOS Screen Recording settings, enable it, and quit/reopen it.')
  console.log('This is an ad-hoc signed local build, not a notarized distribution. Rebuilding may require renewed permission.')
} catch (error) {
  rmSync(staging, { recursive: true, force: true })
  throw error
}
