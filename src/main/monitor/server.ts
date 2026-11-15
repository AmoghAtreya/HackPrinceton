import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { LearningMonitor } from './bus.ts'
import { monitorPage } from './page.ts'

export interface MonitorAddress { localUrl: string; lanUrl?: string }

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) if (item.family === 'IPv4' && !item.internal) return item.address
  }
  return undefined
}

/**
 * Serves the learning monitor page and a Server-Sent Events stream.
 *
 * Local by default (127.0.0.1). With `share` on it listens on the local
 * network so a second device's browser can watch, which is how the demo shows
 * one person using Triage while judges watch the learning on another screen.
 * Every request needs the random token in the link; personal values are
 * already masked in the event stream. Read-only: nothing here can change the app.
 */
export class MonitorServer {
  private server?: Server
  private readonly monitor: LearningMonitor
  private readonly share: boolean
  readonly token = randomBytes(16).toString('hex')
  private address?: MonitorAddress

  constructor(monitor: LearningMonitor, options: { share?: boolean } = {}) {
    this.monitor = monitor
    this.share = Boolean(options.share)
  }

  async start(port = 0): Promise<MonitorAddress> {
    if (this.address) return this.address
    const server = createServer((request, response) => this.handle(request, response))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, this.share ? '0.0.0.0' : '127.0.0.1', () => resolve())
    })
    this.server = server
    const actual = (server.address() as { port: number }).port
    const lan = this.share ? lanAddress() : undefined
    this.address = {
      localUrl: `http://127.0.0.1:${actual}/?t=${this.token}`,
      ...(lan ? { lanUrl: `http://${lan}:${actual}/?t=${this.token}` } : {})
    }
    return this.address
  }

  private authorized(url: URL): boolean {
    const given = Buffer.from(url.searchParams.get('t') ?? '')
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://monitor.invalid')
    if (request.method !== 'GET' || !this.authorized(url)) { response.writeHead(404).end(); return }
    const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
    if (url.pathname === '/') {
      const nonce = randomBytes(12).toString('base64')
      response.writeHead(200, {
        ...common, 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      })
      response.end(monitorPage(nonce))
    } else if (url.pathname === '/info') {
      response.writeHead(200, { ...common, 'content-type': 'application/json' })
      response.end(JSON.stringify({ lanUrl: this.address?.lanUrl ?? null }))
    } else if (url.pathname === '/events') {
      response.writeHead(200, { ...common, 'content-type': 'text/event-stream', connection: 'keep-alive' })
      const send = (event: { seq: number }) => { response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`) }
      const after = Number(request.headers['last-event-id'] ?? 0) || 0
      for (const event of this.monitor.since(after)) send(event)
      const unsubscribe = this.monitor.subscribe(send)
      const ping = setInterval(() => response.write(': ping\n\n'), 15000)
      request.on('close', () => { clearInterval(ping); unsubscribe() })
    } else response.writeHead(404).end()
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.address = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
