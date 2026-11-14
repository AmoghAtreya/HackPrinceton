import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VoiceShortcutState, VoiceAvailability } from '../../shared/voice-contracts.ts'
import { HelperFrames, helperEventSchema, MAX_FRAME, type SpeechAdapter, type SpeechEvent } from './adapter.ts'

export class NativeSpeechAdapter implements SpeechAdapter {
  private generation = randomUUID()
  private nonce = randomUUID()
  private seq = 0
  private received = 0
  private directory?: string
  private server?: Server
  private socket?: Socket
  private closed = false
  private authenticated = false
  private helperPid?: number
  private heartbeat?: ReturnType<typeof setInterval>
  private heartbeatDeadline?: ReturnType<typeof setTimeout>
  private connectDeadline?: ReturnType<typeof setTimeout>
  private pending?: { resolve: (value: VoiceAvailability) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  private initializePromise?: Promise<VoiceAvailability>
  private registration?: { id: string; resolve: (state: VoiceShortcutState) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  private capturing = false
  private teardown?: Promise<void>
  private helperApp: string
  private event: (event: SpeechEvent) => void
  private lost: () => void
  constructor(helperApp: string, event: (event: SpeechEvent) => void, lost: () => void) {
    this.helperApp = helperApp; this.event = event; this.lost = lost
  }
  initialize(): Promise<VoiceAvailability> {
    this.initializePromise ??= this.launch()
    return this.initializePromise
  }
  private async launch(): Promise<VoiceAvailability> {
    if (this.closed || process.platform !== 'darwin' || !existsSync(join(this.helperApp, 'Contents/MacOS/TriageVoiceHelper')))
      throw new Error('helper unavailable')
    // macOS sockaddr_un is short; /tmp resolves privately and keeps the path under 104 bytes.
    this.directory = mkdtempSync(join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'triage-v-'))
    chmodSync(this.directory, 0o700)
    const path = join(this.directory, 's')
    const frames = new HelperFrames()
    const availability = this.waitAvailability(10000)
    this.server = createServer((socket) => {
      if (this.socket || this.closed) { socket.destroy(); return }
      this.socket = socket
      socket.on('error', () => this.fail())
      socket.on('close', () => { if (!this.closed) this.fail() })
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const raw of frames.push(chunk)) {
            const message = helperEventSchema.parse(raw)
            if (message.generation !== this.generation || message.seq !== this.received + 1) throw new Error('sequence')
            this.received = message.seq
            if (!this.authenticated) {
              if (message.type !== 'hello' || message.nonce !== this.nonce) throw new Error('handshake')
              this.authenticated = true
              clearTimeout(this.connectDeadline)
              // Verify executable before using a reported PID for bounded forced shutdown.
              execFile('/bin/ps', ['-p', String(message.pid), '-o', 'comm='], { timeout: 1000 }, (error, stdout) => {
                if (!error && stdout.trim() === join(this.helperApp, 'Contents/MacOS/TriageVoiceHelper')) {
                  if (!this.closed) this.helperPid = message.pid
                }
              })
              this.send('initialize')
              this.scheduleHeartbeat()
              continue
            }
            if (message.type === 'hello') throw new Error('duplicate handshake')
            if (message.type === 'pong') { clearTimeout(this.heartbeatDeadline); this.heartbeatDeadline = undefined; continue }
            if (message.type === 'shortcut') {
              if (!this.registration || message.operationId !== this.registration.id) throw new Error('registration')
              const pending = this.registration; this.registration = undefined
              clearTimeout(pending.timer)
              pending.resolve({ chord: message.chord, status: message.status, notice: message.notice })
            }
            if (message.type === 'availability' && this.pending) {
              const pending = this.pending; this.pending = undefined
              clearTimeout(pending.timer); pending.resolve(message.availability)
            }
            if (message.type === 'final' || message.type === 'failed' || message.type === 'stopped') {
              this.capturing = false; this.scheduleHeartbeat()
            }
            this.event(message)
          }
        } catch { this.fail() }
      })
      this.send('hello', { nonce: this.nonce })
    })
    this.server.on('error', () => this.fail())
    this.connectDeadline = setTimeout(() => this.fail(), 5000)
    this.server.listen(path, () => {
      if (this.closed) return
      chmodSync(path, 0o600)
      execFile('/usr/bin/open', ['-g', '-n', '-a', this.helperApp, '--args', path], { timeout: 5000 }, (error) => {
        if (error && !this.closed) this.fail()
      })
    })
    return availability
  }
  private waitAvailability(timeout: number): Promise<VoiceAvailability> {
    if (this.pending || this.closed) return Promise.reject(new Error('unavailable'))
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, timer: setTimeout(() => this.fail(), timeout) }
    })
  }
  async requestPermissions(): Promise<VoiceAvailability> {
    const pending = this.waitAvailability(120000)
    try { this.send('permissions') } catch { this.fail() }
    return pending
  }
  registerShortcut(chord: string, prompt: boolean): Promise<VoiceShortcutState> {
    if (this.registration || this.closed) return Promise.reject(new Error('registration unavailable'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      this.registration = { id, resolve, reject, timer: setTimeout(() => this.fail(), 5000) }
      try { this.send('shortcut-register', { operationId: id, chord, prompt }) } catch { this.fail() }
    })
  }
  private scheduleHeartbeat(): void {
    clearInterval(this.heartbeat)
    if (this.closed) return
    const ping = () => {
      if (this.closed) return
      try {
        this.send('ping')
        if (!this.heartbeatDeadline) this.heartbeatDeadline = setTimeout(() => this.fail(), this.capturing ? 2000 : 5000)
      } catch { this.fail() }
    }
    this.heartbeat = setInterval(ping, this.capturing ? 2000 : 5000)
    ping()
  }
  private send(type: string, fields: Record<string, unknown> = {}): void {
    if (this.closed || !this.socket || this.socket.destroyed) throw new Error('closed')
    const frame = Buffer.from(JSON.stringify({ v: 1, generation: this.generation, seq: ++this.seq, type, ...fields }) + '\n')
    if (frame.length > MAX_FRAME || this.socket.writableLength + frame.length > MAX_FRAME * 32) throw new Error('backpressure')
    this.socket.write(frame)
  }
  start(sessionId: string, microphoneId: string | null): void {
    this.capturing = true
    this.send('start', { sessionId, ...(microphoneId ? { microphoneId } : {}) })
    this.scheduleHeartbeat()
  }
  finish(sessionId: string): void { this.send('finish', { sessionId }) }
  cancel(sessionId: string): void { this.send('cancel', { sessionId }) }
  private fail(): void {
    if (this.closed) return
    this.dispose()
    this.lost()
  }
  dispose(): Promise<void> {
    if (this.closed) return this.teardown ?? Promise.resolve()
    try { if (this.authenticated) this.send('shutdown') } catch { /* EOF independently stops the helper. */ }
    this.closed = true
    clearInterval(this.heartbeat); clearTimeout(this.heartbeatDeadline); clearTimeout(this.connectDeadline)
    if (this.pending) {
      clearTimeout(this.pending.timer); this.pending.reject(new Error('helper closed')); this.pending = undefined
    }
    if (this.registration) {
      clearTimeout(this.registration.timer); this.registration.reject(new Error('helper closed')); this.registration = undefined
    }
    const socket = this.socket
    const pid = this.helperPid
    this.teardown = new Promise<void>((resolve) => {
      if (!socket || socket.destroyed) { resolve(); return }
      const stop = setTimeout(() => {
        // Only a PID whose executable matched the bundled helper may be terminated.
        if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
        socket.destroy()
        resolve()
      }, 1000)
      socket.once('close', () => { clearTimeout(stop); resolve() })
      socket.end()
      if (socket.writableLength) socket.destroy()
    })
    this.server?.close()
    if (this.directory) rmSync(this.directory, { recursive: true, force: true })
    return this.teardown
  }
}
