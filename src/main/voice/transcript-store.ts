import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranscriptRecord } from '../../shared/voice-contracts.ts'

/**
 * Where finished recordings go. The local file store is the default; a
 * DynamoDB-backed store can implement the same interface later.
 */
export interface TranscriptStore {
  save(record: TranscriptRecord): Promise<void>
  recent(limit: number): Promise<TranscriptRecord[]>
}

/** Append-only JSON Lines file in Triage's user-data folder (not encrypted). */
export class LocalTranscriptStore implements TranscriptStore {
  readonly file: string
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string) {
    this.file = join(directory, 'voice-transcripts.jsonl')
  }

  save(record: TranscriptRecord): Promise<void> {
    // Serialize appends so concurrent saves never interleave lines.
    const write = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await appendFile(this.file, JSON.stringify(record) + '\n', { mode: 0o600 })
    })
    this.writes = write.catch(() => undefined)
    return write
  }

  async recent(limit: number): Promise<TranscriptRecord[]> {
    await this.writes
    let content: string
    try { content = await readFile(this.file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: TranscriptRecord[] = []
    const lines = content.split('\n')
    for (let index = lines.length - 1; index >= 0 && records.length < limit; index--) {
      const line = lines[index].trim()
      if (!line) continue
      try { records.push(JSON.parse(line) as TranscriptRecord) }
      catch { /* Skip a partially written or corrupted line. */ }
    }
    return records
  }
}
