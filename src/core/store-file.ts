import { normalizeDisplayCurrency } from './currency'
import path from 'node:path'
import { normalizeForwards, emptyStore, validExtensionSecretName, type StoreData, type StoredHost, type StoredSettings } from './vault'
import { migrateStore, STORE_VERSION } from './vault-migrate'
import { normalizeConnectionTimeout, normalizeKeepaliveInterval } from './host-connection'
import { recoverHostMeta } from './host-meta'
import { clearHostSecrets, pruneTombstones, storedHostTombstone, storedGroupTombstone } from './vault-tombstones'
import { readJsonFile, writeRejectedJsonFile, type FileErrorLogger } from './json-file'

type Check = (value: unknown) => boolean
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const string: Check = (value) => typeof value === 'string'
const requiredText: Check = (value) => typeof value === 'string' && value.trim().length > 0
const number: Check = (value) => typeof value === 'number' && Number.isFinite(value)
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const boolean: Check = (value) => typeof value === 'boolean'
const nullable = (check: Check): Check => (value) => value === null || check(value)
const oneOf = (...values: unknown[]): Check => (value) => values.includes(value)
const integer = (min: number, max: number): Check => (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const shape = (fields: Record<string, Check>): Check => (value) =>
  record(value) && Object.entries(fields).every(([key, check]) => check(value[key]))
const port = integer(1, 65535)
const auth = oneOf('password', 'privateKey', 'keyboard-interactive', 'agent')
const credentials = {
  host: requiredText, port, username: requiredText, authType: auth,
  passwordEnc: nullable(string), privateKeyEnc: nullable(string),
  privateKeyPath: nullable(string), passphraseEnc: nullable(string)
}
const agent = nullable(shape({ socket: nullable(string), identityFile: nullable(string), forward: boolean }))
const host = shape({
  connectionTimeoutSec: (value) => { try { normalizeConnectionTimeout(value); return true } catch { return false } },
  keepaliveIntervalSec: (value) => { try { normalizeKeepaliveInterval(value); return true } catch { return false } },
  persistent: boolean,
  forwards: (value) => { try { normalizeForwards(value); return true } catch { return false } },
  ...credentials,
  agent,
  id: requiredText, groupId: nullable(string), name: requiredText,
  proxy: nullable(shape({ type: oneOf('http', 'socks5'), host: requiredText, port, username: nullable(string), passwordEnc: nullable(string) })),
  jumps: (value) => Array.isArray(value) && value.length <= 5 && value.every(shape({ ...credentials, agent })), startupCommand: nullable(string), createdAt: number, updatedAt: number
})
const group = shape({ id: requiredText, name: requiredText, sortOrder: number })
const backupChecks = {
  rememberUnlock: boolean,
  kdf: nullable(shape({ opslimit: integer(1, 10), memlimit: integer(8192, 1073741824), salt: requiredText })),
  verifier: nullable(string), lastAutoBackupAt: nullable(number),
  webdav: nullable(shape({ url: string, username: string, passwordEnc: nullable(string), remoteDir: string })),
  s3: nullable(shape({ endpoint: string, bucket: string, region: string, accessKeyId: string, secretAccessKeyEnc: nullable(string), prefix: string, forcePathStyle: boolean }))
}
const settingsChecks = {
  autoCollect: boolean,
  collectionIntervalMinutes: oneOf(1, 5, 15),
  verifySecrets: boolean,
  language: oneOf('zh', 'en'), theme: oneOf('system', 'light', 'dark'),
  fontSize: integer(11, 22), transferConcurrency: integer(1, 8), packSmallFiles: boolean,
  sidebarCollapsed: boolean, backgroundStay: boolean
}

function normalizeExtensionSecrets(value: unknown, rejected: unknown[]): StoreData['localExtensionSecrets'] {
  const result: StoreData['localExtensionSecrets'] = {}
  if (value === undefined) return result
  if (!record(value)) { rejected.push({ value }); return result }
  for (const [owner, slots] of Object.entries(value)) {
    if (!validExtensionSecretName(owner) || !record(slots)) { rejected.push({ owner, value: slots }); continue }
    const kept: StoreData['localExtensionSecrets'][string] = {}
    for (const [slot, entry] of Object.entries(slots)) {
      if (!validExtensionSecretName(slot) || !record(entry) || Object.keys(entry).length !== 1 ||
          typeof entry.valueEnc !== 'string' || entry.valueEnc.length > 128 * 1024 ||
          !/^(?:safe|mp|mem):[A-Za-z0-9+/_=-]*$/.test(entry.valueEnc)) {
        rejected.push({ owner, slot, value: entry })
      } else kept[slot] = { valueEnc: entry.valueEnc }
    }
    if (Object.keys(kept).length) result[owner] = kept
  }
  return result
}

function fillNullable(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result = { ...value }
  for (const key of keys) result[key] = value[key] ?? null
  return result
}
const secretFields = ['passwordEnc', 'privateKeyEnc', 'privateKeyPath', 'passphraseEnc']

function normalizeHost(value: unknown): StoredHost | null {
  if (!record(value)) return null
  if (requiredText(value.id) && timestamp(value.updatedAt) && timestamp(value.deletedAt)) {
    const deleted = { ...storedHostTombstone({ id: value.id as string, updatedAt: value.updatedAt, deletedAt: value.deletedAt }), ...value } as unknown as StoredHost
    // Tombstones need only their identity and timestamps; invalid connection data is discarded.
    if (!host(deleted)) return storedHostTombstone({ id: value.id as string, updatedAt: value.updatedAt, deletedAt: value.deletedAt })
    deleted.meta = recoverHostMeta(value.meta)
    clearHostSecrets(deleted)
    return deleted
  }
  const normalized = fillNullable(value, [...secretFields, 'groupId', 'startupCommand', 'proxy', 'agent', 'connectionTimeoutSec', 'keepaliveIntervalSec'])
  if (record(normalized.proxy)) normalized.proxy = fillNullable(normalized.proxy, ['username', 'passwordEnc'])
  if (Array.isArray(normalized.jumps)) normalized.jumps = normalized.jumps.map((jump) => {
    if (!record(jump)) return jump
    return { ...fillNullable(jump, secretFields), agent: jump.authType === 'agent' && jump.agent != null
      ? (record(jump.agent) ? { ...jump.agent, forward: false } : jump.agent) : null }
  })
  try { normalized.forwards = normalizeForwards(normalized.forwards) } catch { return null }
  if (normalized.authType !== 'agent') normalized.agent = null
  normalized.meta = recoverHostMeta(value.meta)
  normalized.deletedAt = timestamp(value.deletedAt) ? value.deletedAt : null
  normalized.createdAt = number(value.createdAt) ? value.createdAt : 0
  normalized.updatedAt = number(value.updatedAt) ? value.updatedAt : normalized.createdAt
  return host(normalized) ? normalized as unknown as StoredHost : null
}

function normalizeGroup(value: unknown, migrationTime: number): StoreData['groups'][number] | null {
  if (!record(value)) return null
  const updatedAt = timestamp(value.updatedAt) ? value.updatedAt : timestamp(value.createdAt) ? value.createdAt : migrationTime
  const deletedAt = timestamp(value.deletedAt) ? value.deletedAt : null
  if (deletedAt !== null && requiredText(value.id) && !group(value)) {
    return storedGroupTombstone({ id: value.id as string, updatedAt, deletedAt })
  }
  const normalized = { ...value, sortOrder: number(value.sortOrder) ? value.sortOrder : 0, updatedAt, deletedAt }
  return group(normalized) ? normalized as unknown as StoreData['groups'][number] : null
}

function applyValidFields(target: object, value: unknown, checks: Record<string, Check>): void {
  if (!record(value)) return
  for (const [key, check] of Object.entries(checks)) {
    if (check(value[key])) Reflect.set(target, key, value[key])
  }
}

function normalizeSettings(value: unknown): StoredSettings {
  const defaults = emptyStore().settings
  applyValidFields(defaults, value, settingsChecks)
  if (record(value)) {
    defaults.displayCurrency = normalizeDisplayCurrency(value.displayCurrency)
  }
  if (record(value)) applyValidFields(defaults.backup, value.backup, backupChecks)
  return defaults
}

function loadRecords<T>(values: unknown[], normalize: (value: unknown) => T | null, rejected: unknown[], originals: unknown[] = values): T[] {
  const result: T[] = []
  for (const [index, value] of values.entries()) {
    const normalized = normalize(value)
    if (normalized === null) rejected.push(originals[index])
    else result.push(normalized)
  }
  return result
}

export interface StoreFileResult {
  data: StoreData
  migratedFrom: number | null
  /** True only after the rejected records have been successfully preserved. */
  hadRejectedRecords: boolean
}

export function readStoreFile(filePath: string, logError: FileErrorLogger = console.error): StoreFileResult {
  // Only parse/envelope failures may quarantine the whole store. Per-record recovery
  // and its I/O happen afterwards so a full disk cannot turn valid hosts into an empty vault.
  const migrationTime = Date.now()
  const parsed = readJsonFile(filePath, (value) => {
    const migrated = migrateStore(value, migrationTime, path.resolve(filePath))
    const original = value as { hosts: unknown[]; groups: unknown[] }
    return { ...migrated, original }
  }, () => ({ data: emptyStore(), migratedFrom: null, original: { hosts: [], groups: [] } }), logError)
  const rejected = { hosts: [] as unknown[], groups: [] as unknown[] }
  const rejectedSecrets: unknown[] = []
  const data = pruneTombstones({
    version: STORE_VERSION,
    hosts: loadRecords(parsed.data.hosts, normalizeHost, rejected.hosts, parsed.original.hosts),
    groups: loadRecords(parsed.data.groups, (value) => normalizeGroup(value, migrationTime), rejected.groups, parsed.original.groups),
    settings: normalizeSettings(parsed.data.settings),
    localExtensionSecrets: normalizeExtensionSecrets(parsed.data.localExtensionSecrets, rejectedSecrets)
  }, migrationTime)
  const hadRejectedRecords = rejected.hosts.length > 0 || rejected.groups.length > 0 || rejectedSecrets.length > 0
  if (hadRejectedRecords) {
    let preserved: string
    try {
      preserved = writeRejectedJsonFile(filePath, { ...rejected, ...(rejectedSecrets.length ? { localExtensionSecrets: rejectedSecrets } : {}) })
    } catch (error) {
      logError('无法保留异常记录，已停止读取主机库', error)
      throw new Error('无法保留异常记录，已停止读取主机库', { cause: error })
    }
    logError(`主机库含异常记录，已保留至 ${preserved}`)
  }
  return { data, hadRejectedRecords, migratedFrom: parsed.migratedFrom }
}
