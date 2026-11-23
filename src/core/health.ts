import { effectiveRenewAt, DAY_MS, localDate, renewalStatus, REMINDER_WINDOW_DAYS } from './reminders'
import type { HostMeta, HostPublic, HostSnapshot } from '../shared/types'

const DAY = DAY_MS
export function healthScore(snapshot: HostSnapshot, meta: HostMeta, now: number, checks: number | { score: number } | undefined = snapshot.securityScore) {
  const reasons: { level: 'warn' | 'bad'; key: string; detail: string }[] = []
  let score = 100
  const deduct = (points: number, key: string, detail: string) => {
    score -= points
    reasons.push({ level: points >= 20 ? 'bad' : 'warn', key, detail })
  }
  const disk = snapshot.disk.status === 'unavailable' ? [] : snapshot.disk.data
  const highest = Math.max(0, ...disk.map((item) => item.usagePercent))
  if (highest > 80) deduct(highest > 90 ? 30 : 15, 'disk', `${highest}%`)
  if (snapshot.memory.status !== 'unavailable') {
    const m = snapshot.memory.data
    if (m.totalBytes && m.availableBytes !== null && m.availableBytes / m.totalBytes < 0.1) {
      deduct(20, 'memory', `${(m.availableBytes / m.totalBytes * 100).toFixed(1)}%`)
    }
    if (m.swapTotalBytes && m.swapUsedBytes !== null && m.swapUsedBytes / m.swapTotalBytes > 0.5) {
      deduct(10, 'swap', `${(m.swapUsedBytes / m.swapTotalBytes * 100).toFixed(1)}%`)
    }
  }
  const cores = snapshot.cpu.status === 'unavailable' ? null : snapshot.cpu.data.cores
  const load = snapshot.load.status === 'unavailable' ? null : snapshot.load.data.one
  if (cores && load !== null && load / cores > 2) deduct(15, 'load', `${(load / cores).toFixed(2)}`)
  const certs = snapshot.certs.status === 'unavailable' ? [] : snapshot.certs.data
  const expiry = Math.min(...certs.flatMap((cert) => cert.unreferenced !== false || cert.expiresAt === null ? [] : [cert.expiresAt]))
  if (expiry <= now + REMINDER_WINDOW_DAYS * DAY) deduct(expiry <= now + 7 * DAY ? 25 : 10, 'certs', localDate(expiry))
  const renewAt = effectiveRenewAt(meta, now)
  if (renewAt !== null && renewalStatus(renewAt, now) !== 'normal') deduct(renewAt <= now + 7 * DAY ? 20 : 5, 'renew', localDate(renewAt))
  const security = typeof checks === 'number' ? checks : checks?.score
  if (security !== undefined && security < 80) deduct(security < 60 ? 15 : 5, 'security', String(security))
  // Missing software (no Docker, no systemd) is a normal state; only failed or forbidden sections leave a gap.
  const incomplete = Object.entries(snapshot).some(([key, section]) => key !== 'collectedAt' && section && typeof section === 'object' && section.status === 'unavailable' &&
    (section.reason === 'error' || section.reason === 'permission-denied'))
  return { score: Math.max(0, score), reasons, incomplete }
}

/** Amounts remain in minor currency units until display. */
export function monthlyCost(meta: HostMeta): number {
  if (meta.price === null) return 0
  return meta.billingCycle === 'monthly' ? meta.price : meta.billingCycle === 'quarterly' ? meta.price / 3 : meta.billingCycle === 'yearly' ? meta.price / 12 : 0
}

export function costSummary<T extends Pick<HostPublic, 'id' | 'name' | 'meta'>>(hosts: T[], now = Date.now()) {
  const currencies: Record<string, number> = {}
  for (const { meta } of hosts) {
    if (meta.currency && meta.price !== null && meta.billingCycle && meta.billingCycle !== 'once') {
      currencies[meta.currency] = (currencies[meta.currency] ?? 0) + monthlyCost(meta)
    }
  }
  const expiring = hosts.filter(({ meta }) => renewalStatus(effectiveRenewAt(meta, now), now) !== 'normal')
    .sort((a, b) => effectiveRenewAt(a.meta, now)! - effectiveRenewAt(b.meta, now)!)
  return { currencies, expiring }
}
