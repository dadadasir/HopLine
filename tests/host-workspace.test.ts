import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCollect } from '../src/core/collect/parse'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { collectionUnknown, hostIssues, resourceValues, snapshotSections } from '../src/renderer/src/logic/host-workspace'
import type { CollectRecord, HostSnapshot } from '../src/shared/types'

const now = Date.UTC(2026, 9, 28)
const host = () => new Vault(emptyStore(), new MemorySecretCodec()).saveHost({ name: 'Host', groupId: null, host: 'localhost', username: 'test', port: 22, authType: 'agent' })
const snapshot = () => parseCollect(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/collect/services.txt'), 'utf8'), now)
const record = (s = snapshot()): CollectRecord => ({ snapshot: s, updatedAt: now, error: null })

describe('host workspace snapshot rendering data', () => {
  it('excludes scalar metadata and future fields from detail sections', () => {
    const s = { ...snapshot(), securityScore: 47, futureMetadata: 'extra' } as HostSnapshot
    const sections = snapshotSections(s)
    expect(sections).toHaveLength(11)
    expect(sections.every((section) => !['collectedAt', 'securityScore', 'futureMetadata'].includes(section.key))).toBe(true)
    expect(() => JSON.stringify(sections)).not.toThrow()
  })
  it('tolerates absent or malformed historical section values without producing undefined rows', () => {
    const s = { ...snapshot(), os: 42, memory: { status: 'complete', data: undefined }, cpu: null } as unknown as HostSnapshot
    const sections = snapshotSections(s)
    expect(sections.some((section) => section.key === 'os' || section.key === 'cpu')).toBe(false)
    expect(sections.find((section) => section.key === 'memory')?.rows).toEqual([])
  })
})

describe('overview evidence and unknown states', () => {
  it('does not present a historical snapshot after a failed refresh as current metrics or current risk', () => {
    const s = snapshot()
    s.disk = { status: 'complete', data: [{ filesystem: '/dev/root', mountpoint: '/', totalBytes: 100, usedBytes: 99, availableBytes: 1, usagePercent: 99 }] }
    const failed = { ...record(s), error: 'connection timed out' }
    expect(collectionUnknown(failed)).toBe(true)
    expect(resourceValues(failed)).toEqual({ cpu: null, memory: null, disk: null })
    expect(hostIssues(host(), failed, now, 'zh')).toEqual([])
    expect(hostIssues(host(), record(s), now, 'zh')).toContainEqual(expect.objectContaining({ key: 'disk', section: 'maintenance' }))
  })
  it('keeps renewal reminders even when collection has never succeeded', () => {
    const h = host(); h.meta.renewAt = now + 86_400_000
    expect(collectionUnknown(undefined)).toBe(true)
    expect(hostIssues(h, undefined, now, 'en')).toEqual([expect.objectContaining({ key: 'renew', section: 'assets', level: 'warn' })])
    expect(hostIssues(h, undefined, now + 2 * 86_400_000, 'en')[0].level).toBe('bad')
  })
  it('distinguishes missing software from permission failures and partial measurements', () => {
    const s = snapshot()
    for (const key of ['os', 'uptime', 'cpu', 'memory', 'load', 'disk', 'listeners', 'docker', 'services', 'web', 'certs'] as const) {
      s[key] = { status: 'unavailable', reason: 'not-applicable' }
    }
    expect(collectionUnknown(record(s), now)).toBe(false)
    s.docker = { status: 'unavailable', reason: 'not-installed' }
    expect(collectionUnknown(record(s), now)).toBe(false)
    s.os = { status: 'unavailable', reason: 'permission-denied' }
    expect(collectionUnknown(record(s), now)).toBe(true)
    s.os = { status: 'partial', data: { id: null, version: null, name: 'Linux', kernel: null, architecture: null } }
    expect(collectionUnknown(record(s), now)).toBe(true)
  })
})

it.each([[15, true], [16, false]])('uses the shared renewal attention window at day %s', (days, expected) => {
  const value = host()
  value.meta.renewAt = now + days * 86400000
  expect(hostIssues(value, undefined, now, 'zh').some(issue => issue.key === 'renew')).toBe(expected)
})

it('keeps renewal day as soon in both languages and uses an ISO local date', () => {
  const value = host(), due = new Date(2026, 0, 31).getTime()
  value.meta.renewAt = due
  for (const locale of ['zh', 'en'] as const) {
    const current = hostIssues(value, undefined, due + 23 * 3600000, locale).find(item => item.key === 'renew')!
    expect(current).toMatchObject({ level: 'warn', detail: '2026-01-31' })
    expect(current.title).toBe(locale === 'zh' ? '今天续费' : 'Renews today')
    expect(hostIssues(value, undefined, new Date(2026, 1, 1).getTime(), locale).find(item => item.key === 'renew')?.level).toBe('bad')
  }
})
