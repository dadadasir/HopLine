import { effectiveRenewAt } from '../../../core/reminders'
import { REMINDER_WINDOW_DAYS, DAY_MS, localDate } from '../../../core/reminders'
import type { HostInput, HostPublic, HostSnapshot, Locale, Section } from '@shared/types'
import { pricedHostMeta } from '../../../core/host-meta'
import { translate } from '../i18n'

export function highestDisk(section: HostSnapshot['disk']) {
  return section.status === 'unavailable' ? null : section.data.reduce<(typeof section.data)[number] | null>((best, disk) => !best || disk.usagePercent > best.usagePercent ? disk : best, null)
}
export function sectionNote(section: Section<unknown> | undefined, locale: Locale, includeDetail = true): string {
  if (!section) return translate(locale, 'overview.never')
  return [section.status === 'unavailable' ? translate(locale, `overview.${section.reason}`) : section.status === 'partial' ? translate(locale, 'overview.incomplete') : '', includeDetail ? section.note : null].filter(Boolean).join(' · ')
}
export function cardCounts(snapshot: HostSnapshot | null, now: number, locale: Locale) {
  return (['docker', 'services', 'web', 'certs'] as const).map((key) => {
    const section = snapshot?.[key]
    const count = !section || section.status === 'unavailable' ? '—' : section.data.length
    // Expired and soon-to-expire are reported separately; the window matches the shared public reminder window.
    const certs = key === 'certs' && snapshot?.certs.status !== 'unavailable' ? (snapshot?.certs.data ?? []).filter((cert) => cert.unreferenced === false) : []
    const expired = certs.filter((cert) => cert.expiresAt !== null && cert.expiresAt <= now).length
    const expiring = certs.filter((cert) => cert.expiresAt !== null && cert.expiresAt > now && cert.expiresAt <= now + REMINDER_WINDOW_DAYS * DAY_MS).length
    const notes = [
      expired ? translate(locale, 'overview.certExpired', { count: expired }) : '',
      expiring ? translate(locale, 'overview.certExpiry', { count: expiring }) : ''
    ].filter(Boolean).join(locale === 'zh' ? '，' : ', ')
    const unavailable = section?.status === 'unavailable' ? translate(locale, `overview.short.${section.reason}`) : ''
    const label = translate(locale, `overview.${key}`)
    return { key, text: unavailable ? locale === 'zh' ? `${label}（${unavailable}）` : `${label} (${unavailable})` : `${label} ${count}${notes ? ` (${notes})` : ''}`, note: sectionNote(section, locale) }
  })
}
export function updatedAgo(updatedAt: number | null, now: number, locale: Locale): string {
  if (updatedAt === null || !Number.isFinite(updatedAt)) return translate(locale, 'overview.never')
  const minutes = Math.floor((now - updatedAt) / 60_000)
  if (minutes <= 0) return translate(locale, 'overview.justUpdated')
  return translate(locale, minutes === 1 ? 'overview.agoOne' : 'overview.ago', { minutes })
}
export function money(amount: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { style: 'currency', currency, currencyDisplay: currency === 'USD' || currency === 'CNY' ? 'narrowSymbol' : 'symbol' }).format(amount / 100)
}
export function assetInput(host: HostPublic, fields: Record<string, string>): HostInput {
  const price = Number(fields.price)
  const renewAt = fields.renewAt ? new Date(`${fields.renewAt}T00:00:00`).getTime() : null
  if (fields.renewAt && (!/^\d{4}-\d{2}-\d{2}$/.test(fields.renewAt) || !Number.isFinite(renewAt) || localDate(renewAt!) !== fields.renewAt)) throw new Error('续费日期必须使用有效的 YYYY-MM-DD 日期')
  const meta = pricedHostMeta(host.meta, {
    provider: fields.provider || null, price: fields.price.trim() ? price < 0 ? price : Math.round(price * 100) : null,
    currency: fields.currency.trim().toUpperCase() || null, billingCycle: (fields.billingCycle || null) as HostPublic['meta']['billingCycle'],
    renewAt,
    ...(host.meta.renewAt !== null && renewAt !== host.meta.renewAt && renewAt === effectiveRenewAt(host.meta, Date.now()) ? { renewalAnchorDay: host.meta.renewalAnchorDay ?? new Date(host.meta.renewAt).getDate() } : {}),
    tags: fields.tags.split(',').map((tag) => tag.trim()).filter(Boolean), note: fields.note || null
  })
  return { ...host, meta }
}
export function dateInput(timestamp: number | null): string {
  if (timestamp === null) return ''
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Human-readable detail-table cell: sizes in binary units, durations in days/hours, dates without time. */
export function formatCell(column: string, value: unknown, locale: Locale): string {
  if (value == null) return '—'
  if (column === 'unreferenced') return translate(locale, value ? 'overview.certUnreferenced' : 'overview.certReferenced')
  if (typeof value === 'number' && column.endsWith('Bytes')) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let size = value, unit = 0
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
    return `${unit ? size.toFixed(size < 10 ? 1 : 0) : size} ${units[unit]}`
  }
  if (typeof value === 'number' && column === 'seconds') {
    const days = Math.floor(value / 86_400), hours = Math.floor(value % 86_400 / 3_600), minutes = Math.floor(value % 3_600 / 60)
    const zh = locale === 'zh'
    if (days) return zh ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`
    return zh ? `${hours} 小时 ${minutes} 分钟` : `${hours}h ${minutes}m`
  }
  if (typeof value === 'number' && column === 'usagePercent') return `${value}%`
  if (column === 'expiresAt') return localDate(Number(value))
  return String(value)
}
