import { isIP } from 'node:net'
import { redact } from '../runbook/engine'
import { evaluate } from './rules'
import type { Section, HostListener, HostCertificate, HostOs } from '../../shared/types'
import type { SecurityIgnores, SecurityReport, SecurityResult, SecuritySnapshot } from './types'

const states = new Set(['pass', 'fail', 'unknown'])
const sshValues = new Set(['yes', 'no', 'prohibit-password', 'without-password', 'forced-commands-only'])
const osIds = new Set(['debian', 'ubuntu', 'centos', 'centos-stream', 'alpine'])

/** Only observation text is secret-bearing; protocol fields and numbers retain their meaning. */
export function redactSecurityReport(report: SecurityReport, password?: string): SecurityReport {
  if (!password) return report
  const secrets = [...new Set([password, password.toLowerCase(), JSON.stringify(password).slice(1, -1)])]
  const text = (value: string) => redact(value, secrets)
  const optional = (value: string | null) => value === null ? null : text(value)
  const osId = (value: string | null) => value !== null && osIds.has(value) ? value : optional(value)
  const version = (value: string | null) => value !== null && /^\d+(?:\.\d+)*$/.test(value) ? value : optional(value)
  const listener = (value: HostListener): HostListener => ({ ...value,
    address: value.address === '*' || isIP(value.address) ? value.address : text(value.address), process: optional(value.process) })
  const certificate = (value: HostCertificate): HostCertificate => ({ ...value, domain: optional(value.domain) })
  const os = (value: HostOs): HostOs => ({ ...value, id: osId(value.id), version: version(value.version),
    name: optional(value.name), kernel: optional(value.kernel), architecture: optional(value.architecture) })
  const section = <T>(value: Section<T>, transform: (data: T) => T): Section<T> => ({ ...value,
    ...(value.note === undefined ? {} : { note: text(value.note) }),
    ...(value.status === 'unavailable' ? {} : { data: transform(value.data) }) })
  const unchanged = <T>(value: T) => value
  const source = report.snapshot
  const snapshot: SecuritySnapshot = { collectedAt: source.collectedAt,
    os: section(source.os, os), listeners: section(source.listeners, (rows) => rows.map(listener)),
    tls: section(source.tls, (rows) => rows.map(certificate)),
    sshd: section(source.sshd, (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
      key === 'port' && /^\d{1,5}$/.test(value) || key !== 'port' && sshValues.has(value) ? value : text(value)]))),
    firewall: section(source.firewall, unchanged), updates: section(source.updates, unchanged), bruteforce: section(source.bruteforce, unchanged),
    accounts: section(source.accounts, (value) => ({ uid0: value.uid0.map(text), empty: value.empty?.map(text) ?? null })),
    processes: section(source.processes, (rows) => rows.map(text)) }

  const freeText = (value: unknown): unknown => typeof value === 'string' ? text(value)
    : Array.isArray(value) ? value.map(freeText)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeText(item)])) : value
  const evidence = (result: SecurityResult): string => {
    try {
      const value = JSON.parse(result.evidence) as { key: string; params: { raw: string; state: string; reason: string }; note?: string }
      let raw = value.params.raw
      if (['ssh-root-login', 'ssh-password-auth', 'ssh-empty-passwords'].includes(result.id)) {
        if (!sshValues.has(raw)) raw = text(raw)
      } else if (result.id === 'ssh-default-port' && /^\d{1,5}$/.test(raw)) {
        // A parsed port is public diagnostic data, even when it equals the password.
      } else {
        try {
          const parsed = JSON.parse(raw)
          const clean = (result.id === 'db-exposed' || result.id === 'docker-api-exposed') && Array.isArray(parsed) ? parsed.map(listener)
            : result.id === 'tls-expiring' && Array.isArray(parsed) ? parsed.map(certificate)
              : result.id === 'os-eol' && parsed && typeof parsed === 'object' ? { ...parsed, os: osId(parsed.os ?? null), version: version(parsed.version ?? null) }
                : freeText(parsed)
          raw = JSON.stringify(clean)
        } catch { raw = text(raw) }
      }
      return JSON.stringify({ ...value, params: { ...value.params, raw }, ...(value.note === undefined ? {} : { note: text(value.note) }) })
    } catch { return text(result.evidence) }
  }
  const results = report.results.map((result) => {
    let fix = result.fix
    // Only account names are free text interpolated into generated commands. Do
    // not offer a command with a redacted/changed account name for copying.
    if (fix && ['uid0-accounts', 'empty-password-accounts'].includes(result.id) &&
        [...fix.commands.matchAll(/'([^']+)'/g)].some((match) => text(match[1]!) !== match[1])) fix = { ...fix, commands: '' }
    return { ...result, evidence: evidence(result), ...(fix ? { fix } : {}) }
  })
  const ignores = Object.fromEntries(Object.entries(report.ignores).map(([id, value]) => [id, { ...value, note: text(value.note) }]))
  return { ...report, snapshot, results, ignores }
}

/** Ignore toggles must not reclassify text that was already redacted for storage. */
export function applySecurityIgnores(report: SecurityReport, ignores: SecurityIgnores): SecurityResult[] {
  let legacy: SecurityResult[] | undefined
  return report.results.map((result) => {
    let state: SecurityResult['status'] | undefined
    let structured = false
    try {
      const evidence = JSON.parse(result.evidence)
      if (evidence?.key === `security.evidence.${result.id}` && states.has(evidence.params?.state)) { state = evidence.params.state; structured = true }
    } catch { /* Reports predating structured evidence use the original collection time. */ }
    if (!state && states.has(result.status)) state = result.status
    if (!state) {
      legacy ??= evaluate(report.snapshot, {}, report.snapshot.collectedAt)
      state = legacy.find((value) => value.id === result.id)?.status ?? 'unknown'
    }
    const evidence = structured ? result.evidence : JSON.stringify({ key: `security.evidence.${result.id}`, params: {
      raw: result.evidence.replace(/^Incomplete or unavailable data\. /, '').split('\n')[0], state, reason: ''
    } })
    return { ...result, evidence, status: Object.hasOwn(ignores, result.id) ? 'ignored' : state }
  })
}
