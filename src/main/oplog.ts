import fs from 'node:fs'
import path from 'node:path'
import { renameReplaceSync } from '../core/win-platform'
import type { OpLogEntry } from '../shared/types'

function cleanupMeasurements(value: unknown): OpLogEntry['cleanup'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!['estimatedBytes', 'actualBytes'].every((key) => row[key] === null || typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && (row[key] as number) >= 0)) return undefined
  return { estimatedBytes: row.estimatedBytes as number | null, actualBytes: row.actualBytes as number | null }
}

export class OpLog {
  constructor(private readonly directory: string) {}
  private file(hostId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(hostId)) throw new Error('主机标识不合法')
    return path.join(this.directory, `${hostId}.jsonl`)
  }
  list(hostId: string): OpLogEntry[] {
    let content: string
    try { content = fs.readFileSync(this.file(hostId), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    return content.split('\n').flatMap((line) => {
      try {
        const row = JSON.parse(line)
        if (!row || !['at', 'durationMs'].every((key) => typeof row[key] === 'number') ||
          !['runbookId', 'stepId', 'title', 'reason', 'output'].every((key) => typeof row[key] === 'string') ||
          !['executed', 'already', 'skipped', 'unavailable', 'failed'].includes(row.status)) return []
        const cleanup = cleanupMeasurements(row.cleanup), entry = { ...row }
        delete entry.cleanup
        return [{ ...entry, ...(cleanup ? { cleanup } : {}) } as OpLogEntry]
      } catch { return [] }
    }).slice(-2000)
  }
  append(hostId: string, row: OpLogEntry): void {
    const rows = [...this.list(hostId), row].slice(-2000), file = this.file(hostId)
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(`${file}.tmp`, rows.map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 })
    renameReplaceSync(`${file}.tmp`, file)
  }
  delete(hostId: string): void { fs.rmSync(this.file(hostId), { force: true }) }
  hosts(): string[] {
    try { return fs.readdirSync(this.directory).filter((file) => /^[A-Za-z0-9_-]+\.jsonl$/.test(file)).map((file) => file.slice(0, -6)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
}
