import type { HostMeta } from '../shared/types'

export const REMINDER_WINDOW_DAYS = 15
export const DAY_MS = 86_400_000

export function localDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function renewalStatus(renewAt: number | null, now: number): 'normal' | 'soon' | 'overdue' {
  if (renewAt === null) return 'normal'
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  if (renewAt < today.getTime()) return 'overdue'
  return renewAt <= now + REMINDER_WINDOW_DAYS * DAY_MS ? 'soon' : 'normal'
}

export function localDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':')
  return `${localDate(timestamp)} ${time}`
}

/** Each period uses the original day, so February clamping never drifts to the 28th. */
export function effectiveRenewAt(meta: HostMeta, now: number): number | null {
  if (meta.renewAt === null || renewalStatus(meta.renewAt, now) !== 'overdue') return meta.renewAt
  const months = meta.billingCycle === 'monthly' ? 1 : meta.billingCycle === 'quarterly' ? 3 : meta.billingCycle === 'yearly' ? 12 : 0
  if (!months) return meta.renewAt
  const previous = new Date(meta.renewAt), today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = meta.renewalAnchorDay ?? previous.getDate()
  let period = Math.max(1, Math.floor(((today.getFullYear() - previous.getFullYear()) * 12 + today.getMonth() - previous.getMonth()) / months))
  const at = (index: number) => {
    const next = new Date(previous.getFullYear(), previous.getMonth() + index * months, 1)
    next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()))
    return next.getTime()
  }
  while (at(period) < today.getTime()) period++
  return at(period)
}
