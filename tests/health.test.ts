import { describe, expect, it } from 'vitest'
import { healthScore, monthlyCost, costSummary } from '../src/core/health'
import { emptyHostMeta } from '../src/core/host-meta'
import type { HostDisk, HostSnapshot, Section } from '../src/shared/types'

const now = Date.UTC(2026, 9, 27), day = 86_400_000
const complete = <T>(data: T): Section<T> => ({ status: 'complete', data })
const disk = (usagePercent: number): HostDisk => ({ filesystem: '/dev/a', mountpoint: '/', totalBytes: 100, usedBytes: usagePercent, availableBytes: 100 - usagePercent, usagePercent })
function snapshot(): HostSnapshot {
  return {
    collectedAt: now, os: complete({ id: 'linux', version: '1', name: 'Linux', kernel: '1', architecture: 'x64' }),
    uptime: complete({ seconds: 3600 }), cpu: complete({ cores: 4, usagePercent: 20 }),
    memory: complete({ totalBytes: 100, availableBytes: 40, swapTotalBytes: 100, swapUsedBytes: 10 }),
    load: complete({ one: 0, five: 0, fifteen: 0 }), disk: complete([disk(50)]),
    listeners: complete([]), docker: complete([]), services: complete([]), web: complete([]), certs: complete([])
  }
}
const score = (s: HostSnapshot) => healthScore(s, emptyHostMeta(), now)

describe('health score boundaries', () => {
  it('starts at 100 without claiming missing data is healthy', () => {
    expect(score(snapshot())).toEqual({ score: 100, reasons: [], incomplete: false })
  })
  it.each([[80, 100], [80.01, 85], [90, 85], [90.01, 70], [100, 70]])('disk %s gives %s, once for the worst disk', (value, expected) => {
    const s = snapshot(); s.disk = complete([disk(value), disk(value)])
    expect(score(s).score).toBe(expected)
    expect(score(s).reasons.length).toBe(value > 80 ? 1 : 0)
  })
  it.each([[10, 100], [9.99, 80], [0, 80]])('available memory %s gives %s', (value, expected) => {
    const s = snapshot(); s.memory = complete({ totalBytes: 100, availableBytes: value, swapTotalBytes: 0, swapUsedBytes: 0 })
    expect(score(s).score).toBe(expected)
  })
  it.each([[50, 100], [50.01, 90], [100, 90]])('swap %s gives %s', (value, expected) => {
    const s = snapshot(); s.memory = complete({ totalBytes: 100, availableBytes: 50, swapTotalBytes: 100, swapUsedBytes: value })
    expect(score(s).score).toBe(expected)
  })
  it.each([[8, 100], [8.01, 85]])('load %s on four cores gives %s', (value, expected) => {
    const s = snapshot(); s.load = complete({ one: value, five: 100, fifteen: 100 })
    expect(score(s).score).toBe(expected)
  })
  it.each([[-day, 75], [0, 75], [7 * day, 75], [7 * day + 1, 90], [15 * day, 90], [15 * day + 1, 100], [16 * day, 100]])('certificate expiry offset %s gives %s', (offset, expected) => {
    const s = snapshot(); s.certs = complete([{ domain: 'a', unreferenced: false, expiresAt: now + offset }, { domain: 'b', unreferenced: false, expiresAt: now + offset + day }])
    expect(score(s).score).toBe(expected)
  })
  it.each([[-day, 80], [0, 80], [7 * day, 80], [7 * day + 1, 95], [15 * day, 95], [15 * day + 1, 100], [16 * day, 100]])('renewal offset %s gives %s', (offset, expected) => {
    expect(healthScore(snapshot(), { ...emptyHostMeta(), renewAt: now + offset }, now).score).toBe(expected)
  })
  it('clamps at zero and supplies severity, stable keys and details', () => {
    const s = snapshot()
    s.disk = complete([disk(99)])
    s.memory = complete({ totalBytes: 100, availableBytes: 1, swapTotalBytes: 100, swapUsedBytes: 99 })
    s.load = complete({ one: 100, five: 0, fifteen: 0 })
    s.certs = complete([{ domain: 'expired', unreferenced: false, expiresAt: now - day }])
    const result = healthScore(s, { ...emptyHostMeta(), renewAt: now - day }, now)
    expect(result.score).toBe(0)
    expect(result.reasons.map((reason) => reason.key)).toEqual(['disk', 'memory', 'swap', 'load', 'certs', 'renew'])
    expect(result.reasons.every((reason) => reason.detail && ['bad', 'warn'].includes(reason.level))).toBe(true)
  })
  it.each(['os', 'uptime', 'cpu', 'memory', 'load', 'disk', 'listeners', 'docker', 'services', 'web', 'certs'] as const)('unavailable %s does not deduct but marks incomplete', (key) => {
    const s = snapshot(); s[key] = { status: 'unavailable', reason: 'permission-denied' }
    expect(score(s)).toEqual({ score: 100, reasons: [], incomplete: true })
  })
  it('uses known partial data while leaving unknown fields unscored', () => {
    const s = snapshot()
    s.memory = { status: 'partial', data: { totalBytes: 100, availableBytes: null, swapTotalBytes: 100, swapUsedBytes: 90 } }
    s.cpu = { status: 'partial', data: { cores: null, usagePercent: 1 } }
    s.certs = { status: 'partial', data: [{ domain: null, expiresAt: null }] }
    expect(score(s)).toMatchObject({ score: 90, incomplete: false, reasons: [{ key: 'swap' }] })
  })

  it.each(['not-installed', 'not-applicable'] as const)('%s sections are a normal state, not a data gap', (reason) => {
    const s = snapshot()
    s.docker = { status: 'unavailable', reason }
    s.services = { status: 'unavailable', reason }
    expect(score(s)).toEqual({ score: 100, reasons: [], incomplete: false })
  })
})

describe('asset cost summary in minor units', () => {
  it.each([['monthly', 451], ['quarterly', 451 / 3], ['yearly', 451 / 12], ['once', 0], [null, 0]] as const)('converts %s', (billingCycle, expected) => {
    expect(monthlyCost({ ...emptyHostMeta(), price: 451, billingCycle })).toBe(expected)
    expect(monthlyCost({ ...emptyHostMeta(), billingCycle })).toBe(0)
  })
  it('groups currencies without rounding per host and sorts due/overdue renewals', () => {
    const hosts = [
      { id: 'late', name: 'late', meta: { ...emptyHostMeta(), price: 12000, currency: 'USD', billingCycle: 'yearly' as const, renewAt: now + 15 * day } },
      { id: 'past', name: 'past', meta: { ...emptyHostMeta(), price: 900, currency: 'USD', billingCycle: 'quarterly' as const, renewAt: now - day } },
      { id: 'next', name: 'next', meta: { ...emptyHostMeta(), price: 500, currency: 'CNY', billingCycle: 'monthly' as const, renewAt: now + day } },
      { id: 'once', name: 'once', meta: { ...emptyHostMeta(), price: 500, currency: 'EUR', billingCycle: 'once' as const, renewAt: now + 15 * day + 1 } },
      { id: 'unset', name: 'unset', meta: emptyHostMeta() }
    ]
    const result = costSummary(hosts, now)
    expect(result.currencies).toEqual({ USD: 1300, CNY: 500 })
    expect(result.expiring.map((host) => host.id)).toEqual(['next', 'late'])
    expect(hosts.map((host) => host.id)).toEqual(['late', 'past', 'next', 'once', 'unset'])
  })
})
