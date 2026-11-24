import type { CollectRecords, HostPublic, Locale } from '../shared/types'
import { snapshotIsStale } from '../core/snapshot-freshness'

/** Read-only menu labels: no scheduling, network requests or extension business rules. */
export function trayRows(hosts: Pick<HostPublic, 'id' | 'name'>[], records: CollectRecords, locale: Locale, now = Date.now(), intervalMinutes?: number): string[] {
  const en = locale === 'en'
  return hosts.map(host => {
    const row = records[host.id], snapshot = row?.snapshot
    const name = host.name.replace(/[\r\n\t\x00-\x1f&]/g, ' ').slice(0, 90)
    if (row?.needsAttention) return `${name} · ${en ? 'One-time confirmation needed' : '需要确认一次'}`
    if (row?.error) return `${name} · ${en ? 'Last check failed' : '上次检查失败'}`
    if (!snapshot) return `${name} · ${en ? 'Not collected' : '未采集'}`
    if (snapshotIsStale(row, now, intervalMinutes)) return `${name} · ${en ? 'Stale data — refresh needed' : '历史数据，待刷新'}`
    const cpu = snapshot.cpu.status !== 'unavailable' ? snapshot.cpu.data.usagePercent : null
    const disk = snapshot.disk.status !== 'unavailable' ? snapshot.disk.data.map(d => d.usagePercent).filter(Number.isFinite) : []
    const details = [typeof cpu === 'number' && Number.isFinite(cpu) ? `CPU ${Math.round(cpu)}%` : '', disk.length ? `${en ? 'Disk' : '磁盘'} ${Math.round(Math.max(...disk))}%` : ''].filter(Boolean)
    return `${name} · ${details.join(' · ') || (en ? 'Data unavailable' : '数据不可用')}`
  })
}
