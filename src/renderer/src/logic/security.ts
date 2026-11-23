import type { Locale, SecurityResult } from '@shared/types'
import { translate } from '../i18n'

export function securityRows(results: SecurityResult[], group: SecurityResult['status'] | 'hints') {
  return results.filter((r) => group === 'hints' ? r.id === 'ssh-default-port' : r.id !== 'ssh-default-port' && r.status === group)
}

function evidence(result: SecurityResult) {
  try {
    const value = JSON.parse(result.evidence)
    if (value?.key === `security.evidence.${result.id}` && typeof value.params?.raw === 'string') return value as { key: string; params: { raw: string; state: string; reason: string }; note?: string }
  } catch { /* Older reports contain plain text or raw JSON. */ }
  return { key: `security.evidence.${result.id}`, params: { raw: result.evidence.replace(/^Incomplete or unavailable data\. /, '').split('\n')[0], state: result.evidence.startsWith('Incomplete or unavailable data.') ? 'unknown' : result.status, reason: '' }, note: '' }
}

export function evidenceText(result: SecurityResult, locale: Locale): string {
  const t = (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars)
  const { key, params } = evidence(result)
  const unknown = params.state === 'unknown' || result.status === 'unknown'
  let value: unknown, truncated = false
  try { value = JSON.parse(params.raw) } catch { value = params.raw; truncated = /^[\[{]/.test(params.raw) }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const list = Array.isArray(value) ? value : []
  const clean = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[{}\r\n]/g, '') : '—'
  const legacyOS = /^(\S+) (\S+); standard\/community support table: ([\d-]+)/.exec(params.raw)
  const support = t('security.evidence.support', { date: clean(record.date ?? legacyOS?.[3]) })
  if (unknown) {
    const detail = t(result.id === 'security-updates-pending' ? 'security.evidence.queryFailed' : 'security.evidence.unavailable')
    return `${t('security.evidence.unknown', { rule: t(result.title), detail })}${params.reason ? ` ${t(`overview.${params.reason}`)}` : ''}${result.id === 'os-eol' ? ` ${support}` : ''}`
  }
  if (truncated) return t('security.evidence.truncated')
  const passed = params.state === 'pass' || result.status === 'pass'
  if (result.id === 'os-eol') {
    return `${t(passed ? `${key}.pass` : key, { os: clean(record.os ?? legacyOS?.[1]), version: clean(record.version ?? legacyOS?.[2]) })} ${support}`
  }
  const services: Record<number, string> = { 3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 27017: 'MongoDB', 9200: 'Elasticsearch', 11211: 'Memcached', 5984: 'CouchDB' }
  const ports = [...new Set(list.map((item) => item?.port).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))]
  const items = result.id === 'db-exposed' ? ports.map((port) => `${port}${services[port] ? locale === 'zh' ? `（${services[port]}）` : ` (${services[port]})` : ''}`).join(locale === 'zh' ? '、' : ', ') : list.map(clean).join(locale === 'zh' ? '、' : ', ')
  return t(passed ? `${key}.pass` : key, { value: clean(value), items: items || '—', count: list.length })
}

export function commandsText(commands: string, locale: Locale): string {
  return commands.split('\n').map((line) => {
    const legacySetting = /^# Set (\S+) (\S+); review Include and Match overrides\.$/.exec(line)
    if (legacySetting) return `# ${translate(locale, 'security.command.ssh-setting', { key: legacySetting[1], value: legacySetting[2] })}`
    const match = /^# (security\.command\.[\w-]+)(?: (\S+) (\S+))?$/.exec(line)
    return match ? `# ${translate(locale, match[1], { key: match[2] ?? '', value: match[3] ?? '' })}` : line.startsWith('# ') ? `# ${translate(locale, line.slice(2))}` : line
  }).join('\n')
}
