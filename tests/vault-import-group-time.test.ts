import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PortableVault, PortableVaultV1 } from '../src/shared/types'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { migrateStore } from '../src/core/vault-migrate'

const time = Date.UTC(2026, 9, 28)
const createVault = () => new Vault(emptyStore(), new MemorySecretCodec())
beforeEach(() => { vi.useFakeTimers().setSystemTime(time) })
afterEach(() => { vi.useRealTimers() })

function legacyBackup(vault: Vault, version: 1 | 2): PortableVault | PortableVaultV1 {
  const current = vault.exportPortable('fixed')
  const groups = current.groups.map(({ updatedAt: _time, ...group }) => group)
  const hosts = current.hosts.map(({ meta, agent: _agent, jumps, forwards: _forwards, persistent: _persistent, ...host }) => ({
    ...host, ...(version === 2 ? { meta } : {}), jump: jumps[0] ?? null
  }))
  return { ...current, version, hosts, groups } as PortableVault | PortableVaultV1
}

describe('portable group timestamps', () => {
  it.each([1, 2] as const)('does not resurrect a deleted group from a v%s backup without group timestamps', (version) => {
    const vault = createVault()
    const group = vault.saveGroup({ name: '旧组' })
    const host = vault.saveHost({ name: '主机', host: 'example.test', port: 22, username: 'u', authType: 'password', groupId: group.id })
    const backup = legacyBackup(vault, version), original = structuredClone(backup)
    vi.setSystemTime(time + 1)
    vault.deleteGroup(group.id)
    vi.setSystemTime(time + 2)
    vault.importPortable(backup, 'merge')
    expect(vault.listGroups()).toEqual([])
    expect(vault.snapshot().groups[0]).toMatchObject({ id: group.id, deletedAt: time + 1, updatedAt: time + 1 })
    expect(vault.getHost(host.id)?.groupId).toBeNull()
    expect(backup).toEqual(original)
  })

  it.each([1, 2] as const)('imports an unknown v%s group timestamp as zero while preserving explicit replacement', (version) => {
    const source = createVault(), group = source.saveGroup({ name: '历史分组' })
    const target = createVault()
    target.importPortable(legacyBackup(source, version), 'replace')
    expect(target.listGroups()).toEqual([group])
    expect(target.snapshot().groups[0]).toMatchObject({ updatedAt: 0, deletedAt: null })
  })

  it('keeps the disk v1 migration timestamp unchanged', () => {
    const source = createVault(); source.saveGroup({ name: '磁盘分组' })
    expect(migrateStore(legacyBackup(source, 1), time).data.groups[0].updatedAt).toBe(time)
  })

  it.each([null, 'invalid', -1, Infinity, NaN])('rejects an explicit invalid portable group timestamp without changing the vault: %s', (updatedAt) => {
    const vault = createVault(), group = vault.saveGroup({ name: '原分组' })
    const before = vault.snapshot(), backup = vault.exportPortable('fixed')
    backup.groups[0] = { ...backup.groups[0], name: '不应保存', updatedAt } as typeof backup.groups[number]
    expect(() => vault.importPortable(backup, 'merge')).toThrow('备份分组时间格式不正确')
    expect(vault.snapshot()).toEqual(before)
    expect(vault.listGroups()).toEqual([group])
  })
})
