import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostInput, HostMeta, PortableVaultV1, Tombstone } from '../src/shared/types'
import { assertPortable, emptyStore, MemorySecretCodec, Vault, type SecretCodec } from '../src/core/vault'
import { emptyHostMeta } from '../src/core/host-meta'
import { mergeRecords } from '../src/core/vault-merge'
import { migrateStore, NewerVersionError } from '../src/core/vault-migrate'
import { TOMBSTONE_RETENTION_MS } from '../src/core/vault-tombstones'
import legacy from './fixtures/vault-v1.json'

const time = Date.UTC(2026, 9, 27)
const input: HostInput = { name: '主机', host: 'example.test', port: 22, username: 'u', authType: 'password', groupId: null }
const meta: HostMeta = { provider: '示例供应商', price: 1200, currency: 'EUR', billingCycle: 'monthly', renewAt: time, tags: ['示例', '资产'], note: '资产备注' }
const createVault = () => new Vault(emptyStore(), new MemorySecretCodec())
beforeEach(() => { vi.useFakeTimers().setSystemTime(time) })
afterEach(() => { vi.useRealTimers() })

describe('v2 host assets and deletion', () => {
  it('preserves omitted meta and individual fields, clears explicit nulls, and isolates copies', () => {
    const vault = createVault()
    const host = vault.saveHost({ ...input, meta })
    expect(vault.saveHost({ ...input, id: host.id }).meta).toEqual(meta)
    const changed = vault.saveHost({ ...input, id: host.id, meta: { price: 0, provider: undefined, note: null, tags: ['  示例 ', '示例', ' 资产 '] } })
    expect(changed.meta).toEqual({ ...meta, price: 0, note: null })
    const copy = vault.duplicateHost(host.id)
    expect(copy.meta).toEqual(changed.meta)
    copy.meta.tags.push('外部修改')
    vault.saveHost({ ...input, id: host.id, meta: { tags: [] } })
    expect(vault.getHost(copy.id)?.meta.tags).toEqual(meta.tags)
    expect(vault.exportPortable().hosts.find((item) => item.id === copy.id)?.meta).toEqual(changed.meta)
  })

  it.each([
    [{ currency: 'eur' }, '币种必须是有效的 ISO 货币代码'],
    [{ currency: 'EURO' }, '币种'],
    [{ provider: 'a'.repeat(41) }, '厂商'],
    [{ price: -1 }, '价格'], [{ price: 1.5 }, '价格'], [{ price: 1e9 + 1 }, '价格'],
    [{ price: NaN }, '价格'], [{ price: Infinity }, '价格'],
    [{ tags: ['a'.repeat(25)] }, '每个标签最长 24 字符'],
    [{ tags: Array.from({ length: 21 }, (_, i) => String(i)) }, '标签最多 20 个'],
    [{ tags: [42] }, '标签必须是文本数组'], [{ tags: null }, '标签'],
    [{ note: 'a'.repeat(2001) }, '备注'],
    [{ billingCycle: 'weekly' }, '计费周期'], [{ renewAt: -1 }, '续费日期'], [{ renewAt: Infinity }, '续费日期'],
    [null, '资产信息']
  ])('rejects invalid metadata atomically: %j', (patch, message) => {
    const vault = createVault()
    const host = vault.saveHost({ ...input, meta })
    const before = vault.snapshot()
    expect(() => vault.saveHost({ ...input, id: host.id, name: '不应更改', meta: patch as Partial<HostMeta> })).toThrow(message)
    expect(vault.snapshot()).toEqual(before)
  })

  it('accepts metadata limits and normalizes tags before deduplication', () => {
    const vault = createVault()
    const host = vault.saveHost({ ...input, meta: { provider: 'a'.repeat(40), price: 1e9, currency: 'CNY', billingCycle: 'once', renewAt: 0, note: 'a'.repeat(2000), tags: ['  ' + 'a'.repeat(24) + '  ', 'a'.repeat(24)] } })
    expect(host.meta.tags).toEqual(['a'.repeat(24)])
  })

  it('hides deleted hosts from every normal read and removes all nested encrypted secrets', () => {
    const vault = createVault()
    const host = vault.saveHost({ ...input, password: 'password', privateKey: 'key', passphrase: 'phrase',
      proxy: { type: 'http', host: 'proxy.test', port: 8080, password: 'proxy' },
      jumps: [{ host: 'jump.test', port: 22, username: 'j', authType: 'privateKey', password: 'jump', privateKey: 'jump-key', passphrase: 'jump-phrase' }]
    })
    vi.setSystemTime(time + 1)
    vault.deleteHost(host.id)
    expect(vault.listHosts()).toEqual([])
    expect(vault.getHost(host.id)).toBeUndefined()
    expect(() => vault.secretsOf(host.id)).toThrow('主机不存在')
    expect(() => vault.duplicateHost(host.id)).toThrow('主机不存在')
    expect(() => vault.saveHost({ ...input, id: host.id })).toThrow('主机不存在')
    expect(() => vault.deleteHost(host.id)).toThrow('主机不存在')
    const deleted = vault.snapshot().hosts[0]!
    expect(deleted).toMatchObject({ updatedAt: time + 1, deletedAt: time + 1 })
    const secrets: unknown[] = []
    const collect = (record: object) => {
      for (const [key, value] of Object.entries(record)) {
        if (key.endsWith('Enc')) secrets.push(value)
        else if (value && typeof value === 'object') collect(value)
      }
    }
    collect(deleted)
    expect(secrets).toEqual(Array(7).fill(null))
    const portable = vault.exportPortable()
    expect(portable.hosts).toEqual([])
    expect(portable.tombstones.hosts).toEqual([{ id: host.id, updatedAt: time + 1, deletedAt: time + 1 }])
  })

  it('timestamps group rename, reorder and deletion without exposing storage fields', () => {
    const vault = createVault()
    const first = vault.saveGroup({ name: '一' })
    const second = vault.saveGroup({ name: '二' })
    expect(Object.keys(first).sort()).toEqual(['id', 'name', 'sortOrder'])
    vi.setSystemTime(time + 1)
    vault.saveGroup({ id: first.id, name: '改名' })
    expect(vault.snapshot().groups[0]?.updatedAt).toBe(time + 1)
    vi.setSystemTime(time + 2)
    vault.moveGroup(second.id, -1)
    expect(vault.snapshot().groups.every((group) => group.updatedAt === time + 2)).toBe(true)
    const host = vault.saveHost({ ...input, groupId: first.id })
    vi.setSystemTime(time + 3)
    vault.deleteGroup(first.id)
    expect(vault.getHost(host.id)).toMatchObject({ groupId: null, updatedAt: time + 3 })
    expect(vault.listGroups()).toEqual([{ ...second, sortOrder: 0 }])
    expect(vault.snapshot().groups[0]).toMatchObject({ deletedAt: time + 3, updatedAt: time + 3 })
    expect(() => vault.saveGroup({ id: first.id, name: '复活' })).toThrow('分组不存在')
    expect(() => vault.saveHost({ ...input, groupId: first.id })).toThrow('分组不存在')
    expect(vault.exportPortable().groups).toHaveLength(1)
    expect(vault.exportPortable().tombstones.groups).toEqual([{ id: first.id, updatedAt: time + 3, deletedAt: time + 3 }])
  })

  it('prunes only tombstones strictly older than 90 days on load', () => {
    const vault = createVault()
    const group = vault.saveGroup({ name: '删除' })
    const host = vault.saveHost(input)
    vault.deleteGroup(group.id)
    vault.deleteHost(host.id)
    const snapshot = vault.snapshot()
    vi.setSystemTime(time + TOMBSTONE_RETENTION_MS)
    expect(new Vault(snapshot, new MemorySecretCodec()).snapshot()).toEqual(snapshot)
    vi.setSystemTime(time + TOMBSTONE_RETENTION_MS + 1)
    const loaded = new Vault(snapshot, new MemorySecretCodec())
    expect(loaded.snapshot().hosts).toEqual([])
    expect(loaded.snapshot().groups).toEqual([])
    expect(snapshot.hosts).toHaveLength(1)
  })
})

describe('v2 portable merge', () => {
  it.each([
    ['local newer', 2, false, 1, false, 'local'],
    ['incoming newer', 1, false, 2, false, 'incoming'],
    ['incoming delete', 1, false, 2, true, 'incoming'],
    ['no resurrection', 2, true, 1, false, 'local'],
    ['tie deletes incoming', 1, false, 1, true, 'incoming'],
    ['tie deletes local', 1, true, 1, false, 'local'],
    ['tie keeps local', 1, false, 1, false, 'local'],
    ['tie both deleted', 1, true, 1, true, 'local'],
    ['newer record after deletion', 1, true, 2, false, 'incoming']
  ] as const)('%s for both hosts and groups', (_name, localTime, localDeleted, incomingTime, incomingDeleted, winner) => {
    const local = createVault()
    const group = local.saveGroup({ name: 'local' })
    const host = local.saveHost({ ...input, name: 'local', groupId: group.id, password: 'local' })
    const payload = local.exportPortable()
    const state = local.snapshot()
    state.hosts[0]!.updatedAt = time + localTime
    state.groups[0]!.updatedAt = time + localTime
    if (localDeleted) {
      state.hosts[0]!.deletedAt = time + localTime
      state.groups[0]!.deletedAt = time + localTime
    }
    local.replace(state)
    payload.hosts[0] = { ...payload.hosts[0]!, name: 'incoming', password: 'incoming', updatedAt: time + incomingTime }
    payload.groups[0] = { ...payload.groups[0]!, name: 'incoming', updatedAt: time + incomingTime }
    if (incomingDeleted) {
      payload.hosts = []
      payload.groups = []
      payload.tombstones = {
        hosts: [{ id: host.id, updatedAt: time + incomingTime, deletedAt: time + incomingTime }],
        groups: [{ id: group.id, updatedAt: time + incomingTime, deletedAt: time + incomingTime }]
      }
    }
    local.importPortable(payload, 'merge')
    const deleted = winner === 'local' ? localDeleted : incomingDeleted
    const stamp = time + (winner === 'local' ? localTime : incomingTime)
    expect(local.snapshot().hosts[0]).toMatchObject({ updatedAt: stamp, deletedAt: deleted ? stamp : null })
    expect(local.snapshot().groups[0]).toMatchObject({ updatedAt: stamp, deletedAt: deleted ? stamp : null })
    if (deleted) {
      expect(local.listHosts()).toEqual([])
      expect(local.listGroups()).toEqual([])
      expect(local.snapshot().hosts[0]?.passwordEnc).toBeNull()
    } else {
      expect(local.getHost(host.id)?.name).toBe(winner)
      expect(local.listGroups()[0]?.name).toBe(winner)
      expect(local.secretsOf(host.id).password).toBe(winner)
    }
  })

  it('preserves one-sided records and detaches hosts pointing at a deleted group', () => {
    const local = createVault()
    const group = local.saveGroup({ name: '本地组' })
    const host = local.saveHost({ ...input, groupId: group.id })
    const other = createVault()
    const otherHost = other.saveHost(input)
    const payload = other.exportPortable()
    payload.tombstones.groups.push({ id: group.id, updatedAt: time + 1, deletedAt: time + 1 })
    local.importPortable(payload, 'merge')
    expect(local.getHost(host.id)?.groupId).toBeNull()
    expect(local.getHost(otherHost.id)).toBeDefined()
    expect(local.listHosts()).toHaveLength(2)
  })

  it('merges without mutating either input and isolates the returned records', () => {
    const local = [{ id: 'a', updatedAt: 1, deletedAt: null, nested: { name: 'local' } }]
    const incoming = [{ id: 'b', updatedAt: 2, deletedAt: null, nested: { name: 'incoming' } }]
    const before = structuredClone({ local, incoming })
    const merged = mergeRecords(local, incoming)
    merged[0]!.nested.name = 'changed'
    expect({ local, incoming }).toEqual(before)
    expect(merged.map((record) => record.id)).toEqual(['a', 'b'])
  })

  it.each(['merge', 'replace'] as const)('round-trips v2 assets, tombstones and settings with a different codec in %s mode', (mode) => {
    const source = createVault()
    const group = source.saveGroup({ name: '保留组' })
    const removedGroup = source.saveGroup({ name: '删除组' })
    source.deleteGroup(removedGroup.id)
    const host = source.saveHost({ ...input, groupId: group.id, meta, password: 'secret',
      proxy: { type: 'http', host: 'proxy.test', port: 8080, password: 'proxy' },
      jumps: [{ host: 'jump.test', port: 22, username: 'j', authType: 'password', password: 'jump' }]
    })
    const deleted = source.saveHost(input)
    source.deleteHost(deleted.id)
    source.updateSettings({ theme: 'dark', webdav: { url: 'https://dav.test', username: 'u', password: 'dav', remoteDir: 'backup' } })
    const codec: SecretCodec = { encrypt: (plain) => `other:${plain}`, decrypt: (encrypted) => {
      if (!encrypted.startsWith('other:')) throw new Error('错误密钥格式')
      return encrypted.slice(6)
    } }
    const restored = new Vault(emptyStore(), codec)
    const payload = source.exportPortable('fixed')
    restored.importPortable(JSON.parse(JSON.stringify(payload)), mode)
    expect(restored.exportPortable('fixed')).toEqual(payload)
    expect(restored.getHost(host.id)?.passwordEnc).toBe('other:secret')
    expect(restored.secretsOf(host.id)).toEqual(source.secretsOf(host.id))
    expect(restored.webdavPassword()).toBe('dav')
  })

  it('imports v1 with empty assets and an unknown group timestamp', () => {
    const source = createVault()
    source.saveGroup({ name: '旧组' })
    const host = source.saveHost({ ...input, meta, password: 'legacy' })
    const v2 = source.exportPortable()
    const v1: PortableVaultV1 = { ...v2, version: 1, hosts: v2.hosts.map(({ meta: _meta, agent: _agent, jumps, ...rest }) => ({ ...rest, jump: jumps[0] ?? null })), groups: source.listGroups() }
    const target = createVault()
    target.importPortable(v1, 'replace')
    expect(target.getHost(host.id)?.meta).toEqual(emptyHostMeta())
    expect(target.snapshot().groups[0]).toMatchObject({ updatedAt: 0, deletedAt: null })
    expect(target.secretsOf(host.id).password).toBe('legacy')
  })

  it.each([undefined, null, [], {}, { hosts: [], groups: null }, { hosts: [null], groups: [] },
    ...[{ id: '' }, { updatedAt: 'bad' }, { deletedAt: null }, { deletedAt: -1 }, { updatedAt: Infinity }].map((patch) => ({ hosts: [{ id: 'a', updatedAt: time, deletedAt: time, ...patch }], groups: [] }))
  ])('rejects malformed v2 tombstones without altering the vault: %j', (tombstones) => {
    const vault = createVault()
    vault.saveHost(input)
    const before = vault.snapshot()
    const payload = { ...vault.exportPortable(), tombstones }
    expect(() => assertPortable(payload)).toThrow('删除标记')
    expect(() => vault.importPortable(payload as never, 'replace')).toThrow('删除标记')
    expect(vault.snapshot()).toEqual(before)
  })

  it('exports only the three allowed tombstone fields, even if an import has extra secrets', () => {
    const vault = createVault()
    const payload = vault.exportPortable()
    payload.tombstones.hosts.push({ id: 'gone', updatedAt: time, deletedAt: time, password: 'never-store' } as Tombstone)
    vault.importPortable(payload, 'replace')
    expect(JSON.stringify(vault.snapshot())).not.toContain('never-store')
    expect(vault.exportPortable().tombstones.hosts).toEqual([{ id: 'gone', updatedAt: time, deletedAt: time }])
  })
})

describe('version migration', () => {
  it('upgrades v1 without mutating its source and does not remigrate v8', () => {
    const before = structuredClone(legacy)
    const { data, migratedFrom } = migrateStore(legacy, time)
    expect(migratedFrom).toBe(1)
    expect(data.version).toBe(9)
    expect(data.hosts[0]).toMatchObject({ meta: emptyHostMeta(), deletedAt: null, updatedAt: 2000 })
    expect(data.groups[0]).toMatchObject({ updatedAt: time, deletedAt: null })
    expect(legacy).toEqual(before)
    expect(migrateStore(data, time + 1)).toEqual({ data, migratedFrom: null })
  })

  it('rejects newer envelopes before inspecting their schema and only replaces with v8', () => {
    expect(() => migrateStore({ version: 99 })).toThrow(NewerVersionError)
    const vault = createVault()
    expect(() => vault.replace({ ...emptyStore(), version: 1 } as never)).toThrow('无法读取此数据文件')
  })
})
