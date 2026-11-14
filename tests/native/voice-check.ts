// Explicit native acceptance runner: default inspects metadata only; --microphone prompts/captures.
// Prints booleans/counts only. Never print recognized text or device identifiers.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NativeSpeechAdapter } from '../../src/main/voice/native-adapter.ts'
import type { SpeechEvent } from '../../src/main/voice/adapter.ts'

const microphone = process.argv.includes('--microphone')
const helper = resolve(process.argv.find((value) => value.startsWith('--helper='))?.slice(9) ?? 'release/TriageVoiceHelper.app')
let started = false
let final = false
let nonempty = false
let failure = false
let levels = 0
let finishTimer: ReturnType<typeof setTimeout> | undefined
let complete: (() => void) | undefined
let adapter: NativeSpeechAdapter
const sessionId = randomUUID()
const onEvent = (event: SpeechEvent) => {
  if ('sessionId' in event && event.sessionId !== sessionId) return
  if (event.type === 'started') {
    started = true
    console.log('Listening for 4 seconds now. Say “Triage voice check”. Audio and text are not saved.')
    finishTimer = setTimeout(() => adapter.finish(sessionId), 4000)
  }
  if (event.type === 'level') levels++
  if (event.type === 'final') { final = true; nonempty = Boolean(event.text.trim()); complete?.() }
  if (event.type === 'failed') { failure = true; complete?.() }
}
adapter = new NativeSpeechAdapter(helper, onEvent, () => { failure = true; complete?.() })
try {
  const available = await adapter.initialize()
  console.log(JSON.stringify({ check: 'initialized', microphone: available.microphone, speech: available.speech,
    onDevice: available.onDevice, available: available.available, devices: available.devices.length }))
  assert.equal(started, false)
  if (microphone) {
    console.log('Authorized native check: allow voice permissions for Triage Voice Helper. Recording begins 3 seconds after approval.')
    const permissions = await adapter.requestPermissions()
    assert.equal(permissions.microphone, 'authorized', 'Microphone permission not granted')
    assert.equal(permissions.speech, 'authorized', 'Speech permission not granted')
    assert.ok(permissions.onDevice && permissions.available, 'Local recognition unavailable')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { failure = true; resolve() }, 10000)
      complete = () => { clearTimeout(timeout); resolve() }
      adapter.start(sessionId, null)
    })
    console.log(JSON.stringify({ check: 'transcription', started, final, nonempty, levels, failure }))
    assert.ok(started && final && nonempty && !failure, 'Native recognition acceptance not established')
  } else {
    await new Promise((resolve) => setTimeout(resolve, 6000))
    assert.equal(started, false)
    assert.equal(failure, false)
    console.log('PASS: private handshake, local availability, idle heartbeat, no capture event.')
  }
} finally { clearTimeout(finishTimer); await adapter.dispose() }
