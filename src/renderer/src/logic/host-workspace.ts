import { effectiveRenewAt, REMINDER_WINDOW_DAYS, renewalStatus, localDate } from '../../../core/reminders'
import type { CollectRecord, HostPublic, HostSnapshot, Locale, Section } from '@shared/types'
import { healthScore } from '../../../core/health'
import { snapshotIsStale } from '../../../core/snapshot-freshness'
export { snapshotIsStale } from '../../../core/snapshot-freshness'
import { highestDisk } from './overview'
import { translate } from '../i18n'

import type { HostSection } from '../state/navigation'
export type { HostSection } from '../state/navigation'
export interface HostIssue { key: string; title: string; detail: string; level: 'warn' | 'bad'; section: HostSection }

/** Collection metadata and future fields must never be treated as table sections. */
export const snapshotSectionKeys = ['os', 'uptime', 'cpu', 'memory', 'load', 'disk', 'listeners', 'docker', 'services', 'web', 'certs'] as const
export function snapshotSections(snapshot: HostSnapshot) {
  return snapshotSectionKeys.flatMap((key) => {
    const section = snapshot[key] as Section<unknown> | undefined
    if (!section || !['complete', 'partial', 'unavailable'].includes(section.status)) return []
    const data = section.status === 'unavailable' ? [] : Array.isArray(section.data) ? section.data : [section.data]
    const rows = data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
    return [{ key, section, rows, columns: [...new Set(rows.flatMap((row) => Object.keys(row)))] }]
  })
}

export function hostIssues(host: HostPublic, record: CollectRecord | undefined, now: number, locale: Locale, intervalMinutes?: number): HostIssue[] {
  const snapshot = record?.snapshot
  // A failed refresh leaves a historical snapshot. Do not present it as current evidence.
  const reasons = snapshot && !record?.error && !snapshotIsStale(record, now, intervalMinutes) ? healthScore(snapshot, { ...host.meta, renewAt: null }, now, record?.securityScore).reasons : []
  const issues: HostIssue[] = reasons.map((reason) => ({ ...reason,
    title: translate(locale, `overview.reason.${reason.key}`),
    section: reason.key === 'security' ? 'security' : reason.key === 'disk' ? 'maintenance' : 'status'
  }))
  const renewAt = effectiveRenewAt(host.meta, now)
  const today = renewAt !== null && localDate(renewAt) === localDate(now)
  const renewal = renewalStatus(renewAt, now)
  if (renewAt !== null && renewal !== 'normal') {
    issues.push({ key: 'renew', level: renewal === 'overdue' ? 'bad' : 'warn', section: 'assets',
      title: today ? (locale === 'zh' ? '今天续费' : 'Renews today') : locale === 'zh' ? renewal === 'overdue' ? '续费日期已到' : `${REMINDER_WINDOW_DAYS} 天内需要续费` : renewal === 'overdue' ? 'Renewal date reached' : `Renewal within ${REMINDER_WINDOW_DAYS} days`,
      detail: localDate(renewAt) })
  }
  return issues.sort((a, b) => Number(b.level === 'bad') - Number(a.level === 'bad'))
}

export function collectionNeedsUpdate(record: CollectRecord | undefined, now = Date.now(), intervalMinutes?: number): boolean {
  return !record?.snapshot || !!record.error || !!record.needsAttention || snapshotIsStale(record, now, intervalMinutes)
}

export function collectionUnknown(record: CollectRecord | undefined, now = Date.now(), intervalMinutes?: number): boolean {
  const snapshot = record?.snapshot
  if (!snapshot || collectionNeedsUpdate(record, now, intervalMinutes)) return true
  return snapshotSections(snapshot).some(({ section }) => section.status === 'partial' || section.status === 'unavailable' && ['error', 'permission-denied'].includes(section.reason))
}

export function resourceValues(record: CollectRecord | undefined) {
  const snapshot = record?.error ? null : record?.snapshot
  const memory = snapshot?.memory.status === 'unavailable' ? null : snapshot?.memory.data
  return {
    cpu: snapshot?.cpu.status === 'unavailable' ? null : snapshot?.cpu.data.usagePercent ?? null,
    memory: memory?.totalBytes && memory.availableBytes !== null ? 100 * (1 - memory.availableBytes / memory.totalBytes) : null,
    disk: snapshot ? highestDisk(snapshot.disk)?.usagePercent ?? null : null
  }
}
