import { expect, it } from 'vitest'
import { effectiveRenewAt, localDate } from '../src/core/reminders'
import { billingSummary } from '../src/core/billing'
import { costSummary, healthScore } from '../src/core/health'
import { emptyHostMeta } from '../src/core/host-meta'
import { hostIssues } from '../src/renderer/src/logic/host-workspace'
import { assetInput, dateInput } from '../src/renderer/src/logic/overview'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import type { HostMeta, HostSnapshot } from '../src/shared/types'
const date = (value: string) => new Date(value + 'T00:00:00').getTime()
it.each([
  ['monthly', '2026-01-31', '2026-02-01', '2026-02-28'],
  ['monthly', '2026-01-31', '2026-11-01', '2026-11-30'],
  ['monthly', '2028-01-31', '2028-02-01', '2028-02-29'],
  ['quarterly', '2026-01-31', '2026-10-31', '2026-10-31'],
  ['yearly', '2024-02-29', '2027-03-01', '2028-02-29'],
  ['monthly', '2026-01-31', '2026-01-31', '2026-01-31'],
  ['once', '2026-01-31', '2026-11-01', '2026-01-31'],
  [null, '2026-01-31', '2026-11-01', '2026-01-31']
] as const)('derives %s from %s on %s without mutating metadata', (billingCycle, from, today, expected) => {
  const meta: HostMeta = { ...emptyHostMeta(), billingCycle, renewAt: date(from) }
  expect(localDate(effectiveRenewAt(meta, date(today) + 86399999)!)).toBe(expected)
  expect(meta.renewAt).toBe(date(from))
  expect(effectiveRenewAt({ ...meta, renewAt: null }, date(today))).toBeNull()
})
it('uses derived dates in scores, counts, workspace and billing, saving only when the asset form is submitted', () => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec()), now = date('2026-03-20')
  const host = vault.saveHost({ groupId: null, name: 'Fixture', host: 'localhost', port: 22, username: 'root', authType: 'password', meta: { price: 100, currency: 'USD', billingCycle: 'monthly', renewAt: date('2026-01-31') } })
  const absent = { status: 'unavailable', reason: 'not-applicable' } as const
  const snapshot: HostSnapshot = { collectedAt: now, os: absent, uptime: absent, cpu: absent, memory: absent, load: absent, disk: absent, listeners: absent, docker: absent, services: absent, web: absent, certs: absent }
  expect(healthScore(snapshot, host.meta, now).reasons).toEqual([{ level: 'warn', key: 'renew', detail: '2026-03-31' }])
  expect(costSummary([host], now).expiring).toHaveLength(1)
  expect(hostIssues(host, undefined, now, 'zh')[0]).toMatchObject({ detail: '2026-03-31', level: 'warn' })
  expect(hostIssues(host, undefined, date('2026-03-31'), 'zh')[0]?.title).toBe('今天续费')
  expect(billingSummary([host], 'USD', null, now).rows[0]).toMatchObject({ renewAt: date('2026-03-31'), status: 'soon' })
  expect(vault.getHost(host.id)?.meta.renewAt).toBe(date('2026-01-31'))
})
it('preserves the original anchor when a derived date is saved from asset fields', () => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  // Use the current month so assetInput can recognize its automatically derived date.
  const today = new Date(), old = new Date(today.getFullYear() - 1, 0, 31).getTime()
  const host = vault.saveHost({ groupId: null, name: 'Fixture', host: 'localhost', port: 22, username: 'root', authType: 'password', meta: { price: 100, currency: 'USD', billingCycle: 'monthly', renewAt: old } })
  const derived = effectiveRenewAt(host.meta, today.getTime())!
  const input = assetInput(host, { price: '1', currency: 'USD', billingCycle: 'monthly', renewAt: dateInput(derived), provider: '', tags: '', note: '' })
  const saved = vault.saveHost(input)
  expect(saved.meta.renewAt).toBe(derived); expect(saved.meta.renewalAnchorDay).toBe(31)
})
