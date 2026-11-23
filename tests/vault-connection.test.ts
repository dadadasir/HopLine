import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostInput, PortableVault } from '../src/shared/types'
import { normalizeConnectionTimeout, normalizeKeepaliveInterval } from '../src/core/host-connection'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { migrateStore } from '../src/core/vault-migrate'
import { readStoreFile } from '../src/core/store-file'
import { writeJsonFile } from '../src/core/json-file'

const time = Date.UTC(2026, 10, 11)
const input: HostInput = { name: '主机', host: 'example.test', port: 22, username: 'u', authType: 'password', groupId: null }
const createVault = () => new Vault(emptyStore(), new MemorySecretCodec())
let directory: string

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(time)
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-connection-vault-'))
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})

/** Recreate the fields present in each prior generation, for both disk and portable records. */
function legacyVersion(value: unknown, version: number) {
  const legacy = structuredClone(value) as { version: number; hosts: Record<string, unknown>[]; groups: Record<string, unknown>[]; tombstones?: unknown }
  legacy.version = version
  for (const host of legacy.hosts) {
    delete host.connectionTimeoutSec
    delete host.keepaliveIntervalSec
    if (version < 7) delete host.persistent
    if (version < 6) delete host.forwards
    if (version < 4) { host.jump = null; delete host.jumps }
    if (version < 3) delete host.agent
    if (version < 2) { delete host.meta; delete host.deletedAt }
  }
  if (version === 1) {
    delete legacy.tombstones
    for (const group of legacy.groups) { delete group.updatedAt; delete group.deletedAt }
  }
  return legacy
}

describe('host connection settings', () => {
  it.each([undefined, null])('uses the default for a missing or null value: %s', (value) => {
    expect(normalizeConnectionTimeout(value)).toBeNull()
    expect(normalizeKeepaliveInterval(value)).toBeNull()
    const vault = createVault()
    const host = vault.saveHost({ ...input, connectionTimeoutSec: value, keepaliveIntervalSec: value })
    expect(host).toMatchObject({ connectionTimeoutSec: null, keepaliveIntervalSec: null })
    expect(vault.getHost(host.id)).toMatchObject({ connectionTimeoutSec: null, keepaliveIntervalSec: null })
  })

  it.each([[5, 0], [120, 300], [30, 60]])('persists bounds and zero heartbeat (%i/%i) through public, duplicate and portable data', (connectionTimeoutSec, keepaliveIntervalSec) => {
    const vault = createVault()
    const fields = { connectionTimeoutSec, keepaliveIntervalSec }
    const host = vault.saveHost({ ...input, ...fields, password: 'temporary-secret' })
    const duplicate = vault.duplicateHost(host.id)
    expect(duplicate.id).not.toBe(host.id)
    for (const id of [host.id, duplicate.id]) {
      expect(vault.listHosts().find((item) => item.id === id)).toMatchObject(fields)
      expect(vault.getHost(id)).toMatchObject(fields)
      expect(vault.exportPortable().hosts.find((item) => item.id === id)).toMatchObject(fields)
      expect(vault.secretsOf(id).password).toBe('temporary-secret')
    }
    const file = path.join(directory, 'store.json')
    writeJsonFile(file, vault.snapshot())
    const restored = readStoreFile(file)
    expect(restored).toMatchObject({ migratedFrom: null, hadRejectedRecords: false, data: vault.snapshot() })
  })

  it('keeps omitted settings and independently resets explicit nulls without changing creation time', () => {
    const vault = createVault()
    const host = vault.saveHost({ ...input, connectionTimeoutSec: 45, keepaliveIntervalSec: 0 })
    vi.setSystemTime(time + 1)
    expect(vault.saveHost({ ...input, id: host.id, name: '改名' })).toMatchObject({ connectionTimeoutSec: 45, keepaliveIntervalSec: 0, createdAt: time, updatedAt: time + 1 })
    expect(vault.saveHost({ ...input, id: host.id, connectionTimeoutSec: null })).toMatchObject({ connectionTimeoutSec: null, keepaliveIntervalSec: 0 })
    expect(vault.saveHost({ ...input, id: host.id, keepaliveIntervalSec: 25 })).toMatchObject({ connectionTimeoutSec: null, keepaliveIntervalSec: 25 })
    expect(vault.saveHost({ ...input, id: host.id, keepaliveIntervalSec: null })).toMatchObject({ connectionTimeoutSec: null, keepaliveIntervalSec: null })
  })

  const invalidCommon: unknown[] = ['', '30', true, false, [], {}, NaN, Infinity, -Infinity, 5.5]
  const fields = [
    { field: 'connectionTimeoutSec', normalize: normalizeConnectionTimeout, error: '连接超时必须是 5 到 120 秒的整数', values: [...invalidCommon, -1, 0, 4, 121] },
    { field: 'keepaliveIntervalSec', normalize: normalizeKeepaliveInterval, error: '心跳间隔必须是 0 到 300 秒的整数', values: [...invalidCommon, -1, 301] }
  ] as const
  for (const { field, normalize, error, values } of fields) {
    it.each(values.map((value) => ({ value })))(`rejects invalid ${field} atomically: %j`, ({ value }) => {
      expect(() => normalize(value)).toThrow(error)
      const vault = createVault()
      const host = vault.saveHost({ ...input, password: 'before', connectionTimeoutSec: 30, keepaliveIntervalSec: 0 })
      const before = vault.snapshot()
      vi.setSystemTime(time + 1)
      const invalid = { ...input, [field]: value } as HostInput
      expect(() => vault.saveHost({ ...invalid, id: host.id, name: '不应改名', password: 'after', meta: { note: '不应保存' } })).toThrow(error)
      expect(vault.snapshot()).toEqual(before)
      expect(() => vault.saveHost(invalid)).toThrow(error)
      expect(vault.snapshot()).toEqual(before)
      const persist = vi.fn()
      expect(() => vault.saveHostWithGroup({ ...invalid, newGroupName: '不应创建' }, persist)).toThrow(error)
      expect(persist).not.toHaveBeenCalled()
      expect(vault.snapshot()).toEqual(before)
    })
  }
})

describe('connection settings migrations and imports', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])('migrates v%i disk and portable hosts without moving their timestamps', (version) => {
    const source = createVault()
    const group = source.saveGroup({ name: '分组' })
    const saved = source.saveHost({ ...input, groupId: group.id, password: 'temporary-secret', connectionTimeoutSec: 30, keepaliveIntervalSec: 0 })
    const disk = legacyVersion(source.snapshot(), version)
    const original = structuredClone(disk)
    const migrated = migrateStore(disk, time + 1000)
    expect(disk).toEqual(original)
    expect(migrated).toMatchObject({ migratedFrom: version, data: { version: 9 } })
    expect(migrated.data.hosts[0]).toMatchObject({ id: saved.id, createdAt: time, updatedAt: time, connectionTimeoutSec: null, keepaliveIntervalSec: null })
    if (version >= 2) expect(migrated.data.groups[0]?.updatedAt).toBe(time)
    const file = path.join(directory, `v${version}.json`)
    fs.writeFileSync(file, JSON.stringify(disk))
    const loaded = readStoreFile(file)
    expect(loaded.hadRejectedRecords).toBe(false)
    expect(loaded.data.hosts[0]).toMatchObject({ createdAt: time, updatedAt: time, connectionTimeoutSec: null, keepaliveIntervalSec: null })
    expect(new Vault(loaded.data, new MemorySecretCodec()).secretsOf(saved.id).password).toBe('temporary-secret')
    const portable = legacyVersion(source.exportPortable(), version)
    const restored = createVault()
    vi.setSystemTime(time + 2000)
    restored.importPortable(portable as unknown as PortableVault, 'replace')
    expect(restored.exportPortable()).toMatchObject({ version: 8, hosts: [{ id: saved.id, createdAt: time, updatedAt: time, connectionTimeoutSec: null, keepaliveIntervalSec: null }] })
    expect(restored.secretsOf(saved.id).password).toBe('temporary-secret')
  })

  it.each(['connectionTimeoutSec', 'keepaliveIntervalSec'] as const)('preserves a malformed v8 %s record for recovery instead of guessing a setting', (field) => {
    const vault = createVault()
    vault.saveHost(input)
    const snapshot = vault.snapshot()
    const rejected = { ...snapshot.hosts[0], id: 'bad', [field]: '30' }
    const file = path.join(directory, 'store.json')
    const bytes = JSON.stringify({ ...snapshot, hosts: [...snapshot.hosts, rejected] })
    fs.writeFileSync(file, bytes)
    const logger = vi.fn()
    expect(readStoreFile(file, logger)).toMatchObject({ hadRejectedRecords: true, data: snapshot })
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    const recovery = fs.readdirSync(directory).find((name) => name.includes('.rejected-'))!
    expect(JSON.parse(fs.readFileSync(path.join(directory, recovery), 'utf8'))).toEqual({ hosts: [rejected], groups: [] })
    expect(logger).toHaveBeenCalledOnce()
  })

  it.each(['merge', 'replace'] as const)('round-trips v8 values and nulls with %s and rejects an invalid second host without partial changes', (mode) => {
    const source = createVault()
    source.saveHost({ ...input, connectionTimeoutSec: 120, keepaliveIntervalSec: 0 })
    source.saveHost({ ...input, name: '默认' })
    const payload = source.exportPortable('fixed')
    const restored = createVault()
    restored.importPortable(payload, mode)
    expect(restored.exportPortable('fixed')).toEqual(payload)
    const before = restored.snapshot()
    const invalid = structuredClone(payload)
    invalid.hosts[0]!.name = '不应保存'
    invalid.hosts[0]!.updatedAt = time + 1
    invalid.hosts[1]!.keepaliveIntervalSec = 301
    expect(() => restored.importPortable(invalid, mode)).toThrow('心跳间隔必须是 0 到 300 秒的整数')
    expect(restored.snapshot()).toEqual(before)
  })

  it('keeps whole-record timestamp and deletion precedence when a v7 import defaults the new fields', () => {
    const local = createVault()
    const host = local.saveHost({ ...input, password: 'original', connectionTimeoutSec: 60, keepaliveIntervalSec: 0 })
    const older = legacyVersion(local.exportPortable(), 7) as unknown as PortableVault
    vi.setSystemTime(time + 2)
    local.saveHost({ ...input, id: host.id, name: '较新本地', password: 'newer', connectionTimeoutSec: 120 })
    local.importPortable(older, 'merge')
    expect(local.getHost(host.id)).toMatchObject({ name: '较新本地', updatedAt: time + 2, connectionTimeoutSec: 120, keepaliveIntervalSec: 0 })
    const incoming = structuredClone(older)
    incoming.hosts[0]!.name = '较新备份'
    incoming.hosts[0]!.updatedAt = time + 3
    local.importPortable(incoming, 'merge')
    expect(local.getHost(host.id)).toMatchObject({ name: '较新备份', createdAt: time, updatedAt: time + 3, connectionTimeoutSec: null, keepaliveIntervalSec: null })
    expect(local.secretsOf(host.id).password).toBe('original')
    incoming.tombstones.hosts = [{ id: host.id, updatedAt: time + 3, deletedAt: time + 3 }]
    local.importPortable(incoming, 'merge')
    expect(local.getHost(host.id)).toBeUndefined()
    local.importPortable(older, 'merge')
    expect(local.getHost(host.id)).toBeUndefined()
    expect(local.exportPortable().tombstones.hosts).toEqual(incoming.tombstones.hosts)
  })
})
