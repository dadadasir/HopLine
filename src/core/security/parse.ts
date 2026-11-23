import { parseCollect } from '../collect/parse'
import type { Section } from '../../shared/types'
import type { SecuritySnapshot } from './types'

export function parseSecurity(stdout: string, now: number): SecuritySnapshot {
  const base = parseCollect(stdout.replace(/^===HOPLINE:tls===$/m, '===HOPLINE:certs==='), now)
  const blocks = new Map([...stdout.replace(/\r\n/g, '\n').matchAll(/^===HOPLINE:(\w+)===\n([\s\S]*?)(?=^===HOPLINE:|$(?![\s\S]))/gm)].map((m) => [m[1], m[2]]))
  function section<T>(name: string, parse: (raw: string) => T): Section<T> {
    const raw = blocks.get(name), failure = raw?.match(/^#HOPLINE-UNAVAILABLE (\S+)(.*)$/m)
    if (!raw?.includes('\n#HOPLINE-END\n')) return { status: 'unavailable', reason: 'error', note: 'Missing or truncated section' }
    if (failure) {
      const reason = (['not-installed', 'permission-denied', 'not-applicable'] as const).find((item) => item === failure[1]) ?? 'error'
      return { status: 'unavailable', reason, note: failure[2]!.trim() }
    }
    const warning = /^#HOPLINE-PARTIAL (.*)$/m.exec(raw)?.[1]
    try { return { status: warning ? 'partial' : 'complete', data: parse(raw), ...(warning ? { note: warning } : {}) } }
    catch { return { status: 'unavailable', reason: 'error', note: 'Unrecognized output' } }
  }
  const flag = (raw: string, name: string) => new RegExp(`^${name}=yes$`, 'm').test(raw) ? true : new RegExp(`^${name}=no$`, 'm').test(raw) ? false : null
  return { collectedAt: now, os: base.os, listeners: base.listeners, tls: base.certs,
    sshd: section('sshd', (raw) => {
      const options: Record<string, string> = {}
      for (const line of raw.split('\n')) {
        if (/^\s*Match\s/i.test(line)) break
        const m = /^\s*(PermitRootLogin|PasswordAuthentication|PermitEmptyPasswords|Port)\s+(\S+)/i.exec(line)
        if (m && !Object.hasOwn(options, m[1].toLowerCase())) options[m[1].toLowerCase()] = m[2].toLowerCase()
      }
      if (!Object.keys(options).length) throw new Error()
      return options
    }),
    firewall: section('firewall', (raw) => {
      if (!/#HOPLINE-SOURCE (ufw|firewall-cmd|nft|iptables|none)/.test(raw)) throw new Error()
      return { active: /^Status: active$|^running$|^\s*(?:ip6? |meta |ct |tcp |udp |counter |iifname |oifname |iif |oif |drop|reject|accept|jump |goto |log |type filter .*policy drop)|^-A |^-P \S+ (?:DROP|REJECT)$/m.test(raw) }
    }),
    updates: section('updates', (raw) => {
      const source = /^#HOPLINE-SOURCE (apt|dnf|yum)$/m.exec(raw)?.[1]
      let pending: number | null = null
      if (source && /^pending-complete=yes$/m.test(raw)) {
        const count = raw.split('\n').filter((line) => source === 'apt' ? /^Inst [^(]+\([^)]*\bsecurity\b/i.test(line) : /^\s*\S+\s+(?:\S*\/Sec\.|security)\s/i.test(line)).length
        // Yum can succeed with no updateinfo metadata. Empty output is not proof of zero updates.
        pending = source === 'yum' && count === 0 ? null : count
      }
      return { auto: flag(raw, 'auto'), reboot: flag(raw, 'reboot'), pending }
    }),
    accounts: section('accounts', (raw) => ({ uid0: [...raw.matchAll(/^uid0=(.*)$/gm)].map((m) => m[1]), empty: /^shadow=readable$/m.test(raw) ? [...raw.matchAll(/^empty=(.*)$/gm)].map((m) => m[1]) : null })),
    bruteforce: section('bruteforce', (raw) => { const active = flag(raw, 'active'); if (active === null) throw new Error(); return { active } }),
    processes: section('processes', (raw) => { if (!/^\s*PID\s/m.test(raw)) throw new Error(); return raw.split('\n').filter((line) => /^\s*\d+\s/.test(line)) }) }
}
