export interface KnownHostEntry {
  host: string
  port: number
  fingerprint: string
  addedAt: number
}

export type HostTrust = 'trusted' | 'unknown' | 'mismatch'

export function judgeHostKey(
  entries: KnownHostEntry[],
  host: string,
  port: number,
  fingerprint: string
): HostTrust {
  const related = entries.filter((entry) => entry.host === host && entry.port === port)
  if (related.length === 0) return 'unknown'
  if (related.some((entry) => entry.fingerprint === fingerprint)) return 'trusted'
  return 'mismatch'
}

export function rememberHostKey(
  entries: KnownHostEntry[],
  entry: KnownHostEntry
): KnownHostEntry[] {
  const next = entries.filter((item) => !(item.host === entry.host && item.port === entry.port))
  next.push(entry)
  return next
}
