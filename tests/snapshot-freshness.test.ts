import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { parseCollect } from '../src/core/collect/parse'
import { SNAPSHOT_MAX_AGE_MS, snapshotIsStale } from '../src/core/snapshot-freshness'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { HostCard } from '../src/renderer/src/components/HostCard'
import { HostStatus } from '../src/renderer/src/components/HostStatus'
import { Overview } from '../src/renderer/src/components/Overview'
import { collectionUnknown, hostIssues } from '../src/renderer/src/logic/host-workspace'
import { getState, patch } from '../src/renderer/src/state/store'
import type { CollectRecord } from '../src/shared/types'

const now = Date.UTC(2026, 10, 12), initial = getState()
const vault = new Vault(emptyStore(), new MemorySecretCodec())
const host = vault.saveHost({ name: '历史主机', host: 'localhost', port: 22, username: 'test', authType: 'agent', groupId: null })
function record(age = 0): CollectRecord {
  const snapshot = parseCollect('', now - age)
  for (const key of ['os', 'uptime', 'cpu', 'memory', 'load', 'disk', 'listeners', 'docker', 'services', 'web', 'certs'] as const) snapshot[key] = { status: 'unavailable', reason: 'not-installed' }
  snapshot.cpu = { status: 'complete', data: { cores: 2, usagePercent: 12 } }
  snapshot.disk = { status: 'complete', data: [{ filesystem: '/dev/test', mountpoint: '/', totalBytes: 100, usedBytes: 99, availableBytes: 1, usagePercent: 99 }] }
  return { snapshot, updatedAt: now - age, error: null }
}
afterEach(() => { patch(() => initial); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('expires at ten minutes and rejects invalid or implausibly future timestamps', () => {
  expect(snapshotIsStale(record(SNAPSHOT_MAX_AGE_MS - 1), now)).toBe(false)
  expect(snapshotIsStale(record(SNAPSHOT_MAX_AGE_MS), now)).toBe(true)
  expect(snapshotIsStale(record(7 * 86400000), now)).toBe(true)
  expect(snapshotIsStale(record(-60001), now)).toBe(true)
  expect(snapshotIsStale({ ...record(-60001), updatedAt: now }, now)).toBe(true)
  expect(snapshotIsStale({ ...record(), updatedAt: null }, now)).toBe(true)
  expect(snapshotIsStale({ ...record(), snapshot: { ...record().snapshot!, collectedAt: NaN } }, now)).toBe(true)
  const old = record(7 * 86400000); old.updatedAt = now
  expect(snapshotIsStale(old, now)).toBe(true)
  expect(snapshotIsStale(undefined, now)).toBe(false)
})

it('keeps renewal reminders while dropping stale resource and security judgements', () => {
  const stale = record(7 * 86400000)
  expect(collectionUnknown(stale, now)).toBe(true)
  expect(hostIssues(host, record(), now, 'zh').some(issue => issue.key === 'disk')).toBe(true)
  expect(hostIssues({ ...host, meta: { ...host.meta, renewAt: now + 86400000 } }, stale, now, 'zh').map(issue => issue.key)).toEqual(['renew'])
})

it.each(['zh', 'en'] as const)('renders stale cards with a muted age, historical bars and no health score (%s)', locale => {
  patch({ settings: { ...vault.settingsPublic(false), language: locale } })
  const noop = () => undefined
  const html = renderToStaticMarkup(createElement(HostCard, { host, record: record(7 * 86400000), issues: [], busy: false, now, locale, onOpen: noop, onRefresh: noop, onConnect: noop, onEdit: noop }))
  expect(html).toContain('data-snapshot-stale="true"')
  expect(html).toContain(locale === 'zh' ? '10080 分钟前更新' : 'Updated 10080 minutes ago')
  expect(html).toContain('gauge-bar')
  expect(html).not.toMatch(/健康分 100|Health 100|运行正常|Healthy|overview\.stale/)
  const status = renderToStaticMarkup(createElement(HostStatus, { host, record: record(7 * 86400000), issues: [], busy: false, now, locale, onIssue: noop }))
  expect(status).not.toContain('role="status"')
  expect(status).toContain('99%')
  expect(status).not.toContain('var(--ok-fg)')
})

it('excludes stale hosts from the overview healthy count and restores current status after refresh', () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  vi.stubGlobal('__HOPLINE_EDITION__', 'community')
  const stale = record(7 * 86400000)
  stale.snapshot!.disk = { status: 'unavailable', reason: 'not-installed' }
  patch({ hosts: [host], snapshots: { [host.id]: stale }, collecting: [], settings: vault.settingsPublic(false) })
  expect(renderToStaticMarkup(createElement(Overview))).toContain('0/1')
  const fresh = { ...stale, updatedAt: now, snapshot: { ...stale.snapshot!, collectedAt: now } }
  patch({ snapshots: { [host.id]: fresh } })
  const html = renderToStaticMarkup(createElement(Overview))
  expect(html).toContain('1/1')
  expect(html).not.toContain('data-snapshot-stale')
})

it.each([[1, 10], [5, 10], [15, 30]] as const)('uses the configured %i minute cadence with a %i minute freshness threshold', (interval, maxAge) => {
  expect(snapshotIsStale(record(maxAge * 60_000 - 1), now, interval)).toBe(false)
  expect(snapshotIsStale(record(maxAge * 60_000), now, interval)).toBe(true)
  expect(collectionUnknown(record(15 * 60_000), now, interval)).toBe(interval !== 15)
})

it('defaults older settings and persists valid auto-collection preferences through backup', () => {
  const legacyData = vault.snapshot()
  Reflect.deleteProperty(legacyData.settings, 'autoCollect')
  Reflect.deleteProperty(legacyData.settings, 'collectionIntervalMinutes')
  const legacy = new Vault(legacyData, new MemorySecretCodec())
  expect(legacy.settingsPublic(false)).toMatchObject({ autoCollect: true, collectionIntervalMinutes: 5 })
  expect(() => legacy.updateSettings({ autoCollect: false, collectionIntervalMinutes: 3 as 5 })).toThrow()
  expect(legacy.settingsPublic(false)).toMatchObject({ autoCollect: true, collectionIntervalMinutes: 5 })
  legacy.updateSettings({ autoCollect: false, collectionIntervalMinutes: 15 })
  const restored = new Vault(emptyStore(), new MemorySecretCodec())
  restored.importPortable(legacy.exportPortable(), 'merge')
  expect(restored.settingsPublic(false)).toMatchObject({ autoCollect: false, collectionIntervalMinutes: 15 })
})

it('uses the trimmed address as an omitted name and preserves long addresses on backup', () => {
  const catalog = new Vault(emptyStore(), new MemorySecretCodec())
  const address = `${'a'.repeat(63)}.${'b'.repeat(40)}.test`
  const row = catalog.saveHost({ name: '  ', host: ` ${address} `, port: 22, username: 'fixture', authType: 'agent', groupId: null })
  expect(row.name).toBe(address)
  const copy = new Vault(emptyStore(), new MemorySecretCodec())
  copy.importPortable(catalog.exportPortable(), 'merge')
  expect(copy.listHosts()[0].name).toBe(address)
})
