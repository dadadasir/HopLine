import { afterEach, expect, it, vi } from 'vitest'
import { effectiveRenewAt, localDate, localDateTime } from '../src/core/reminders'
import { healthScore } from '../src/core/health'
import { emptyHostMeta } from '../src/core/host-meta'
import { formatCell } from '../src/renderer/src/logic/overview'
import type { HostSnapshot } from '../src/shared/types'

afterEach(() => vi.unstubAllEnvs())
it('keeps local renewal/certificate dates in UTC+8 instead of showing the preceding UTC day', () => {
  vi.stubEnv('TZ', 'Asia/Shanghai')
  const date = new Date(2026, 0, 2).getTime()
  expect(new Date(date).toISOString().slice(0, 10)).toBe('2026-01-01')
  expect(localDate(date)).toBe('2026-01-02')
  expect(localDate(effectiveRenewAt({ ...emptyHostMeta(), billingCycle: 'monthly', renewAt: new Date(2025, 0, 31).getTime() }, date)!)).toBe('2026-01-31')
  expect(localDateTime(date)).toBe('2026-01-02 00:00:00')
  const unavailable = { status: 'unavailable', reason: 'not-applicable' } as const
  const snapshot: HostSnapshot = { collectedAt: date, os: unavailable, uptime: unavailable, listeners: unavailable, docker: unavailable, services: unavailable, web: unavailable, disk: { status: 'complete', data: [] }, memory: unavailable, cpu: unavailable, load: unavailable,
    certs: { status: 'complete', data: [{ domain: 'fixture.test', unreferenced: false, expiresAt: date }] } }
  expect(healthScore(snapshot, { ...emptyHostMeta(), renewAt: date }, date).reasons.map(reason => reason.detail)).toEqual(['2026-01-02', '2026-01-02'])
  expect(formatCell('expiresAt', date, 'zh')).toBe('2026-01-02')
})
