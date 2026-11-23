import type { Tombstone } from '../shared/types'
import type { StoredGroup, StoredHost, StoreData } from './vault'
import { emptyHostMeta } from './host-meta'

export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export function clearHostSecrets(host: StoredHost): void {
  host.passwordEnc = null
  host.privateKeyEnc = null
  host.passphraseEnc = null
  if (host.proxy) host.proxy.passwordEnc = null
  for (const jump of host.jumps) {
    jump.passwordEnc = null
    jump.privateKeyEnc = null
    jump.passphraseEnc = null
  }
}

/** Imported tombstones have no connection details; inert defaults keep the storage shape uniform. */
export function storedHostTombstone(tombstone: Tombstone): StoredHost {
  return {
    connectionTimeoutSec: null, keepaliveIntervalSec: null,
    id: tombstone.id, updatedAt: tombstone.updatedAt, deletedAt: tombstone.deletedAt,
    persistent: false, groupId: null, name: '已删除主机', host: '', port: 22, username: '', authType: 'password',
    passwordEnc: null, privateKeyEnc: null, privateKeyPath: null, passphraseEnc: null,
    forwards: [], agent: null, proxy: null, jumps: [], startupCommand: null, createdAt: 0, meta: emptyHostMeta()
  }
}

export function storedGroupTombstone(tombstone: Tombstone): StoredGroup {
  return { id: tombstone.id, updatedAt: tombstone.updatedAt, deletedAt: tombstone.deletedAt, name: '已删除分组', sortOrder: 0 }
}

export function tombstoneOf(record: { id: string; updatedAt: number; deletedAt: number | null }): Tombstone {
  if (record.deletedAt === null) throw new Error('记录尚未删除')
  return { id: record.id, updatedAt: record.updatedAt, deletedAt: record.deletedAt }
}

export function pruneTombstones(data: StoreData, time: number): StoreData {
  const result = structuredClone(data)
  // Repair references before pruning so expired group tombstones still detach their hosts.
  detachDeletedGroups(result)
  const keep = (record: { deletedAt: number | null }) =>
    record.deletedAt === null || time - record.deletedAt <= TOMBSTONE_RETENTION_MS
  result.hosts = result.hosts.filter(keep)
  result.groups = result.groups.filter(keep)
  for (const host of result.hosts) if (host.deletedAt !== null) clearHostSecrets(host)
  return result
}

export function detachDeletedGroups(data: Pick<StoreData, 'hosts' | 'groups'>): void {
  const deleted = new Set(data.groups.filter((group) => group.deletedAt !== null).map((group) => group.id))
  for (const host of data.hosts) if (host.groupId && deleted.has(host.groupId)) host.groupId = null
}
