import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const include = process.env.TRIAGE_NODE_INCLUDE ?? join(dirname(process.execPath), '../include/node')
mkdirSync(join(root, 'release'), { recursive: true })
execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-O2', '-fobjc-arc',
  '-bundle', '-undefined', 'dynamic_lookup', '-I', include,
  '-framework', 'AppKit', '-framework', 'ApplicationServices',
  join(root, 'native/phishing/LinkScanner.mm'), '-o', join(root, 'release/TriageLinkScanner.node')],
{ stdio: 'inherit' })
