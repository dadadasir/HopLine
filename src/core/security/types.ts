import type { HostSnapshot, Section } from '../../shared/types'
export interface SecuritySnapshot {
  collectedAt: number
  os: HostSnapshot['os']; listeners: HostSnapshot['listeners']; tls: HostSnapshot['certs']
  sshd: Section<Record<string, string>>; firewall: Section<{ active: boolean }>
  updates: Section<{ auto: boolean | null; pending: number | null; reboot: boolean | null }>
  bruteforce: Section<{ active: boolean }>; accounts: Section<{ uid0: string[]; empty: string[] | null }>
  processes: Section<string[]>
}
export interface SecurityResult {
  id: string; severity: 'high' | 'medium' | 'low'; status: 'pass' | 'fail' | 'unknown' | 'ignored'
  title: string; evidence: string; fix?: { explain: string; commands: string }
}
export type SecurityIgnores = Record<string, { at: number; note: string }>
export interface SecurityReport { snapshot: SecuritySnapshot; results: SecurityResult[]; score: number; ignores: SecurityIgnores }
