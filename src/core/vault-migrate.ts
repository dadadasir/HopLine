import type { StoreData } from './vault'
import { emptyHostMeta } from './host-meta'

export const STORE_VERSION = 9

export class NewerVersionError extends Error {
  constructor(readonly filePath: string) {
    super('数据文件来自更新版本的 Hopline')
    this.name = 'NewerVersionError'
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

type Envelope = Record<string, unknown> & { version: number; hosts: unknown[]; groups: unknown[] }

function migrateV1(data: Envelope, migrationTime: number): Envelope {
  return {
    ...data,
    version: 2,
    hosts: data.hosts.map((host) => record(host) ? { ...host, meta: emptyHostMeta(), deletedAt: null } : host),
    groups: data.groups.map((group) => record(group) ? { ...group, updatedAt: migrationTime, deletedAt: null } : group)
  }
}

function migrateV2(data: Envelope): Envelope {
  return { ...data, version: 3, hosts: data.hosts.map((host) => record(host) ? { ...host, agent: null } : host) }
}

function migrateV3(data: Envelope): Envelope {
  return { ...data, version: 4, hosts: data.hosts.map((host) => {
    if (!record(host)) return host
    const { jump, ...rest } = host
    return { ...rest, jumps: jump ? [jump] : [] }
  }) }
}

function migrateV4(data: Envelope): Envelope {
  return { ...data, version: 5, hosts: data.hosts.map((host) => record(host) ? {
    ...host, jumps: Array.isArray(host.jumps) ? host.jumps.map((jump) => record(jump) ? { ...jump, agent: null } : jump) : host.jumps
  } : host) }
}

const migrations: Record<number, (data: Envelope, time: number) => Envelope> = { 1: migrateV1, 2: migrateV2, 3: migrateV3, 4: migrateV4, 5: (data) => ({ ...data, version: 6, hosts: data.hosts.map((host) => record(host) ? { ...host, forwards: [] } : host) }) }

migrations[6] = (data) => ({ ...data, version: 7, hosts: data.hosts.map((host) => record(host) ? { ...host, persistent: false } : host) })
migrations[7] = (data) => ({ ...data, version: 8, hosts: data.hosts.map((host) => record(host) ? {
  ...host, connectionTimeoutSec: null, keepaliveIntervalSec: null
} : host) })
migrations[8] = (data) => ({ ...data, version: 9, localExtensionSecrets: {},
  settings: record(data.settings) ? { backgroundStay: true, ...data.settings } : data.settings
})

/** Upgrade without mutation. Disk callers supply the source path; in-memory payloads have none. */
export function migrateStore(raw: unknown, migrationTime = Date.now(), filePath = ''): { data: StoreData; migratedFrom: number | null } {
  if (record(raw) && typeof raw.version === 'number' && raw.version > STORE_VERSION) throw new NewerVersionError(filePath)
  if (!record(raw) || !Number.isInteger(raw.version) || (raw.version as number) < 1 ||
      !Array.isArray(raw.hosts) || !Array.isArray(raw.groups)) throw new Error('主机库结构不正确')
  let data = structuredClone(raw) as Envelope
  const migratedFrom = data.version === STORE_VERSION ? null : data.version
  while (data.version < STORE_VERSION) {
    const migrate = migrations[data.version]
    if (!migrate) throw new Error('无法迁移此数据文件')
    data = migrate(data, migrationTime)
  }
  if (record(data.settings)) { const { automaticFx: _automatic, manualFxRates: _manual, ...settings } = data.settings; data.settings = { displayCurrency: 'auto', ...settings } }
  return { data: data as unknown as StoreData, migratedFrom }
}
