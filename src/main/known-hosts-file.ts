import { judgeHostKey, rememberHostKey, type HostTrust, type KnownHostEntry } from '../core/known-hosts'
import { readJsonFile, writeJsonFile } from '../core/json-file'
import { logError } from './logger'

export class KnownHostFile {
  entries: KnownHostEntry[] = []

  constructor(private readonly filePath: string) {}

  load(): void {
    this.entries = readJsonFile(this.filePath, (value) => {
      const parsed = value as { entries?: unknown } | null
      if (!parsed || !Array.isArray(parsed.entries) || !parsed.entries.every(isKnownHost)) {
        throw new Error('已知主机文件结构不正确')
      }
      return parsed.entries
    }, () => [], logError)
  }

  judge(host: string, port: number, fingerprint: string): HostTrust {
    return judgeHostKey(this.entries, host, port, fingerprint)
  }

  remember(host: string, port: number, fingerprint: string): void {
    this.entries = rememberHostKey(this.entries, { host, port, fingerprint, addedAt: Date.now() })
    this.flush()
  }

  private flush(): void {
    writeJsonFile(this.filePath, { entries: this.entries })
  }
}

function isKnownHost(value: unknown): value is KnownHostEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<KnownHostEntry>
  return typeof entry.host === 'string' && entry.host.length > 0 &&
    typeof entry.port === 'number' && Number.isInteger(entry.port) && entry.port >= 1 && entry.port <= 65535 &&
    typeof entry.fingerprint === 'string' && entry.fingerprint.length > 0 &&
    typeof entry.addedAt === 'number' && Number.isFinite(entry.addedAt)
}
