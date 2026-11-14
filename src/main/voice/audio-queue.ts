/**
 * A push-to-pull bridge: IPC handlers push PCM chunks in, and the Transcribe
 * request pulls them out as an async iterable. Ending the queue lets the
 * stream drain and close cleanly so Transcribe can emit its last final result.
 */
export class AudioQueue implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = []
  private waiting: ((result: IteratorResult<Uint8Array>) => void) | null = null
  private ended = false
  private buffered = 0
  private readonly maxBufferedBytes: number

  /** @param maxBufferedBytes drop audio rather than grow without bound if the network stalls. */
  constructor(maxBufferedBytes = 16000 * 2 * 10) {
    this.maxBufferedBytes = maxBufferedBytes
  }

  push(chunk: Uint8Array): boolean {
    if (this.ended) return false
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: chunk, done: false })
      return true
    }
    if (this.buffered + chunk.byteLength > this.maxBufferedBytes) return false
    this.chunks.push(chunk)
    this.buffered += chunk.byteLength
    return true
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  get isEnded(): boolean { return this.ended }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const chunk = this.chunks.shift()
        if (chunk) {
          this.buffered -= chunk.byteLength
          return Promise.resolve({ value: chunk, done: false })
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => { this.waiting = resolve })
      },
      return: () => {
        this.end()
        this.chunks = []
        this.buffered = 0
        return Promise.resolve({ value: undefined, done: true })
      }
    }
  }
}
