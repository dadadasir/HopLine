import { normalizeCollectionInterval } from './snapshot-freshness'
import { normalizeDisplayCurrency } from './currency'
import type { HostSecretField } from '../shared/host-secrets'
import type {
  ForwardRule,
  CollectionIntervalMinutes,
  AgentConfig,
  AuthType,
  GroupInput,
  HostGroup,
  HostInput,
  HostMeta,
  HostPublic,
  JumpInput,
  JumpPublic,
  PortableHost,
  PortableJump,
  PortableProxy,
  PortableSettings,
  PortableVault,
  PortableVaultV1,
  ProxyInput,
  ProxyPublic,
  S3Input,
  S3Public,
  SettingsPatch,
  SettingsPublic,
  WebDavInput,
  WebDavPublic
} from '../shared/types'

import { applyHostMeta, emptyHostMeta, pricedHostMeta } from './host-meta'
import { normalizeConnectionTimeout, normalizeKeepaliveInterval } from './host-connection'
import { migrateStore, STORE_VERSION } from './vault-migrate'
import { mergeRecords } from './vault-merge'
import { clearHostSecrets, detachDeletedGroups, pruneTombstones, storedGroupTombstone, storedHostTombstone, tombstoneOf } from './vault-tombstones'

export type { PortableVault, PortableVaultV1 } from '../shared/types'

export interface SecretCodec {
  encrypt(plain: string): string
  decrypt(payload: string): string
}

export class MemorySecretCodec implements SecretCodec {
  encrypt(plain: string): string {
    return `mem:${Buffer.from(plain, 'utf8').toString('base64url')}`
  }

  decrypt(payload: string): string {
    if (!payload.startsWith('mem:')) throw new Error('无法解密密钥')
    return Buffer.from(payload.slice(4), 'base64url').toString('utf8')
  }
}

export interface StoredProxy {
  type: 'socks5' | 'http'
  host: string
  port: number
  username: string | null
  passwordEnc: string | null
}

export interface StoredJump {
  agent: AgentConfig | null
  host: string
  port: number
  username: string
  authType: AuthType
  passwordEnc: string | null
  privateKeyEnc: string | null
  privateKeyPath: string | null
  passphraseEnc: string | null
}

export interface StoredHost {
  connectionTimeoutSec: number | null
  keepaliveIntervalSec: number | null
  persistent: boolean
  forwards: ForwardRule[]
  agent: AgentConfig | null
  meta: HostMeta
  deletedAt: number | null
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  passwordEnc: string | null
  privateKeyEnc: string | null
  privateKeyPath: string | null
  passphraseEnc: string | null
  proxy: StoredProxy | null
  jumps: StoredJump[]
  startupCommand: string | null
  createdAt: number
  updatedAt: number
}

export interface StoredWebDav {
  url: string
  username: string
  passwordEnc: string | null
  remoteDir: string
}

export interface StoredS3 {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKeyEnc: string | null
  prefix: string
  forcePathStyle: boolean
}

export interface StoredKdf {
  opslimit: number
  memlimit: number
  salt: string
}

export interface StoredSettings {
  autoCollect: boolean
  collectionIntervalMinutes: CollectionIntervalMinutes
  verifySecrets: boolean
  displayCurrency: string
  language: 'zh' | 'en'
  theme: 'system' | 'light' | 'dark'
  fontSize: number
  transferConcurrency: number
  packSmallFiles: boolean
  sidebarCollapsed: boolean
  backgroundStay: boolean
    backup: {
      rememberUnlock: boolean
      kdf: StoredKdf | null
      /** AEAD token used to check a master password. Never the password itself. */
      verifier: string | null
      webdav: StoredWebDav | null
      s3: StoredS3 | null
      lastAutoBackupAt: number | null
    }
}

export interface StoredGroup extends HostGroup {
  updatedAt: number
  deletedAt: number | null
}

export interface StoreData {
  version: 9
  groups: StoredGroup[]
  hosts: StoredHost[]
  settings: StoredSettings
  /** Local main-process extension credentials; never part of portable backups. */
  localExtensionSecrets: Record<string, Record<string, { valueEnc: string }>>
}

export function validExtensionSecretName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value)
}

function assertExtensionSecretNames(owner: string, slot: string): void {
  if (!validExtensionSecretName(owner) || !validExtensionSecretName(slot)) throw new Error('扩展凭据名称不合法 / Invalid extension credential name')
}

export interface DecryptedSecrets {
  password: string | null
  privateKey: string | null
  passphrase: string | null
  proxyPassword: string | null
  jumps: { password: string | null; privateKey: string | null; passphrase: string | null }[]
}

const AUTH: AuthType[] = ['password', 'privateKey', 'keyboard-interactive', 'agent']

function now(): number {
  return Date.now()
}

function id(): string {
  return crypto.randomUUID()
}

export function emptyStore(): StoreData {
  return {
    version: 9,
    groups: [],
    hosts: [],
    localExtensionSecrets: {},
    settings: {
      autoCollect: true,
      collectionIntervalMinutes: 5,
      verifySecrets: true,
      displayCurrency: 'auto',
      language: 'zh',
      theme: 'system',
      fontSize: 13,
      transferConcurrency: 3,
      packSmallFiles: true,
      sidebarCollapsed: false,
      backgroundStay: true,
      backup: {
        rememberUnlock: true,
        kdf: null,
        verifier: null,
        webdav: null,
        s3: null,
        lastAutoBackupAt: null
      }
    }
  }
}

function cleanText(value: string, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label}不能为空`)
  if (trimmed.length > max) throw new Error(`${label}过长`)
  return trimmed
}

function hostDisplayName(value: string, address: string): string {
  if (typeof value === 'string' && (!value.trim() || value.trim() === address)) return address
  return cleanText(value, '名称', 80)
}

function cleanPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1 到 65535 的整数')
  }
  return port
}

function applySecret(
  current: string | null,
  incoming: string | null | undefined,
  codec: SecretCodec
): string | null {
  if (incoming === undefined) return current
  if (incoming === null) return null
  if (incoming === '') return current
  if (incoming.length > 256 * 1024) throw new Error('密钥内容过大')
  return codec.encrypt(incoming)
}

function decryptMaybe(payload: string | null, codec: SecretCodec): string | null {
  if (!payload) return null
  return codec.decrypt(payload)
}

function toProxyPublic(proxy: StoredProxy | null): ProxyPublic | null {
  if (!proxy) return null
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    hasPassword: Boolean(proxy.passwordEnc)
  }
}

function toJumpPublic(jump: StoredJump): JumpPublic {
  return {
    host: jump.host,
    port: jump.port,
    username: jump.username,
    authType: jump.authType,
    agent: structuredClone(jump.agent),
    hasPassword: Boolean(jump.passwordEnc),
    hasPrivateKey: Boolean(jump.privateKeyEnc),
    privateKeyPath: jump.privateKeyPath,
    hasPassphrase: Boolean(jump.passphraseEnc)
  }
}

export function toHostPublic(host: StoredHost): HostPublic {
  return {
    connectionTimeoutSec: host.connectionTimeoutSec,
    keepaliveIntervalSec: host.keepaliveIntervalSec,
    persistent: host.persistent,
    forwards: structuredClone(host.forwards),
    id: host.id,
    groupId: host.groupId,
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    authType: host.authType,
    agent: structuredClone(host.agent),
    hasPassword: Boolean(host.passwordEnc),
    hasPrivateKey: Boolean(host.privateKeyEnc),
    privateKeyPath: host.privateKeyPath,
    hasPassphrase: Boolean(host.passphraseEnc),
    proxy: toProxyPublic(host.proxy),
    jumps: host.jumps.map(toJumpPublic),
    startupCommand: host.startupCommand,
    createdAt: host.createdAt,
    updatedAt: host.updatedAt,
    meta: structuredClone(host.meta)
  }
}

function normalizeProxy(input: ProxyInput, prev: StoredProxy | null, codec: SecretCodec): StoredProxy {
  return {
    type: input.type === 'http' ? 'http' : 'socks5',
    host: cleanText(input.host, '代理主机', 255),
    port: cleanPort(input.port),
    username: input.username?.trim() ? input.username.trim() : null,
    passwordEnc: applySecret(prev?.passwordEnc ?? null, input.password, codec)
  }
}

function normalizeJump(input: JumpInput, prev: StoredJump | null, codec: SecretCodec): StoredJump {
  if (!AUTH.includes(input.authType)) throw new Error('跳板认证方式不正确')
  const host = cleanText(input.host, '跳板主机', 255)
  const port = cleanPort(input.port)
  const username = cleanText(input.username, '跳板用户', 128)
  if (prev?.host !== host || prev.port !== port || prev.username !== username) prev = null
  return {
    host, port, username,
    authType: input.authType,
    agent: input.authType === 'agent' ? normalizeJumpAgent(input.agent === undefined ? prev?.agent : input.agent) : null,
    passwordEnc: applySecret(prev?.passwordEnc ?? null, input.password, codec),
    privateKeyEnc: applySecret(prev?.privateKeyEnc ?? null, input.privateKey, codec),
    privateKeyPath: input.privateKeyPath === undefined ? (prev?.privateKeyPath ?? null) : input.privateKeyPath?.trim() || null,
    passphraseEnc: applySecret(prev?.passphraseEnc ?? null, input.passphrase, codec)
  }
}

function checkJumps<T>(jumps: T[]): T[] {
  if (!Array.isArray(jumps)) throw new Error('跳板必须是列表')
  if (jumps.length > 5) throw new Error('跳板最多 5 级')
  return jumps
}

function normalizeAgent(input: AgentConfig | null | undefined): AgentConfig {
  if (input == null) return { socket: null, identityFile: null, forward: false }
  if (typeof input !== 'object' || Array.isArray(input) || typeof input.forward !== 'boolean' ||
      ![input.socket, input.identityFile].every((value) => value === null || typeof value === 'string')) {
    throw new Error('Agent 配置不正确')
  }
  return { socket: input.socket?.trim() || null, identityFile: input.identityFile?.trim() || null, forward: input.forward }
}

function normalizeJumpAgent(input: AgentConfig | null | undefined): AgentConfig | null {
  return input == null ? null : { ...normalizeAgent(input), forward: false }
}

function assertAuth(authType: AuthType): AuthType {
  if (!AUTH.includes(authType)) throw new Error('认证方式不正确')
  return authType
}

export class Vault {
  constructor(
    private data: StoreData,
    private codec: SecretCodec
  ) {
    this.replace(data)
  }

  /** Internal persistence, merge and test view, including tombstones and encrypted secrets. */
  snapshot(): StoreData {
    return structuredClone(this.data)
  }

  firstKeystoreSecret(): string | undefined {
    for (const host of this.data.hosts) {
      if (host.deletedAt !== null) continue
      if (host.proxy?.passwordEnc?.startsWith('safe:')) return host.proxy.passwordEnc
      for (const entry of [host, ...host.jumps]) {
        const secret = [entry.passwordEnc, entry.privateKeyEnc, entry.passphraseEnc].find(value => value?.startsWith('safe:'))
        if (secret) return secret
      }
    }
    const { webdav, s3 } = this.data.settings.backup
    if (webdav?.passwordEnc?.startsWith('safe:')) return webdav.passwordEnc
    if (s3?.secretAccessKeyEnc?.startsWith('safe:')) return s3.secretAccessKeyEnc
    for (const slots of Object.values(this.data.localExtensionSecrets)) {
      for (const { valueEnc } of Object.values(slots)) {
        if (valueEnc.startsWith('safe:')) return valueEnc
      }
    }
    return undefined
  }

  /** Stage synchronous mutations and persistence together; keep newer pre-transaction edits on failure. */
  transaction(action: () => void): void {
    const previous = this.data
    this.data = this.snapshot()
    try { action() }
    catch (error) {
      this.data = previous
      throw error
    }
  }

  reencryptSecrets(predicate: (payload: string) => boolean, codec: SecretCodec): number {
    const data = this.snapshot()
    let count = 0
    const reencrypt = (payload: string | null): string | null => {
      if (!payload || !predicate(payload)) return payload
      count++
      return codec.encrypt(this.codec.decrypt(payload))
    }
    for (const host of data.hosts) {
      for (const entry of [host, ...host.jumps]) {
        entry.passwordEnc = reencrypt(entry.passwordEnc)
        entry.privateKeyEnc = reencrypt(entry.privateKeyEnc)
        entry.passphraseEnc = reencrypt(entry.passphraseEnc)
      }
      if (host.proxy) host.proxy.passwordEnc = reencrypt(host.proxy.passwordEnc)
    }
    const { webdav, s3 } = data.settings.backup
    if (webdav) webdav.passwordEnc = reencrypt(webdav.passwordEnc)
    if (s3) s3.secretAccessKeyEnc = reencrypt(s3.secretAccessKeyEnc)
    for (const slots of Object.values(data.localExtensionSecrets)) {
      for (const value of Object.values(slots)) value.valueEnc = reencrypt(value.valueEnc)!
    }
    // Commit only after every field succeeds; timestamps belong to user edits.
    if (count) this.data = data
    return count
  }

  replace(data: StoreData): void {
    if (data.version !== STORE_VERSION) throw new Error('无法读取此数据文件')
    this.data = pruneTombstones(data, now())
    this.data.settings.autoCollect = this.data.settings.autoCollect !== false
    this.data.settings.collectionIntervalMinutes = normalizeCollectionInterval(this.data.settings.collectionIntervalMinutes)
    this.data.settings.verifySecrets = this.data.settings.verifySecrets !== false
    this.data.settings.displayCurrency = normalizeDisplayCurrency(this.data.settings.displayCurrency)
    delete (this.data.settings as unknown as Record<string, unknown>).automaticFx
    delete (this.data.settings as unknown as Record<string, unknown>).manualFxRates
  }

  extensionSecretHas(owner: string, slot: string): boolean {
    assertExtensionSecretNames(owner, slot)
    return Object.hasOwn(this.data.localExtensionSecrets, owner) && Object.hasOwn(this.data.localExtensionSecrets[owner], slot)
  }

  extensionSecretGet(owner: string, slot: string): string | null {
    if (!this.extensionSecretHas(owner, slot)) return null
    return this.codec.decrypt(this.data.localExtensionSecrets[owner][slot].valueEnc)
  }

  /** The caller wraps mutation and synchronous persistence in transaction(). */
  extensionSecretSet(owner: string, slot: string, value: string | null): void {
    assertExtensionSecretNames(owner, slot)
    if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024)) {
      throw new Error('扩展凭据内容不合法 / Invalid extension credential value')
    }
    if (value === null) {
      if (Object.hasOwn(this.data.localExtensionSecrets, owner)) {
        delete this.data.localExtensionSecrets[owner][slot]
        if (!Object.keys(this.data.localExtensionSecrets[owner]).length) delete this.data.localExtensionSecrets[owner]
      }
      return
    }
    const valueEnc = this.codec.encrypt(value)
    if (!Object.hasOwn(this.data.localExtensionSecrets, owner)) this.data.localExtensionSecrets[owner] = {}
    this.data.localExtensionSecrets[owner][slot] = { valueEnc }
  }

  listGroups(): HostGroup[] {
    return this.data.groups.filter((group) => group.deletedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh'))
      .map(toGroupPublic)
  }

  listHosts(): HostPublic[] {
    return this.data.hosts.filter((host) => host.deletedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      .map(toHostPublic)
  }

  getHost(id: string): StoredHost | undefined {
    return this.data.hosts.find((host) => host.id === id && host.deletedAt === null)
  }

  secretsOf(id: string): DecryptedSecrets {
    const host = this.requireHost(id)
    return {
      password: decryptMaybe(host.passwordEnc, this.codec),
      privateKey: decryptMaybe(host.privateKeyEnc, this.codec),
      passphrase: decryptMaybe(host.passphraseEnc, this.codec),
      proxyPassword: decryptMaybe(host.proxy?.passwordEnc ?? null, this.codec),
      jumps: host.jumps.map((jump) => ({
        password: decryptMaybe(jump.passwordEnc, this.codec),
        privateKey: decryptMaybe(jump.privateKeyEnc, this.codec),
        passphrase: decryptMaybe(jump.passphraseEnc, this.codec)
      }))
    }
  }

  hostSecretPayload(id: string, field: HostSecretField): string | null {
    const host = this.requireHost(id)
    if (field === 'proxyPassword') return host.proxy?.passwordEnc ?? null
    const entry = typeof field === 'string' ? host : host.jumps[field.jumpIndex]
    const name = typeof field === 'string' ? field : field.field
    return (name === 'password' ? entry?.passwordEnc : entry?.passphraseEnc) ?? null
  }

  readHostSecret(id: string, field: HostSecretField): string | null {
    return decryptMaybe(this.hostSecretPayload(id, field), this.codec)
  }

  saveGroup(input: GroupInput): HostGroup {
    const name = cleanText(input.name, '分组名称', 40)
    if (input.id) {
      const group = this.data.groups.find((item) => item.id === input.id && item.deletedAt === null)
      if (!group) throw new Error('分组不存在')
      group.name = name
      group.updatedAt = now()
      return toGroupPublic(group)
    }
    const sortOrder = this.data.groups.reduce((max, group) => Math.max(max, group.sortOrder), 0) + 1
    const group: StoredGroup = { id: id(), name, sortOrder, updatedAt: now(), deletedAt: null }
    this.data.groups.push(group)
    return toGroupPublic(group)
  }

  deleteGroup(groupId: string): void {
    const group = this.data.groups.find((item) => item.id === groupId && item.deletedAt === null)
    if (!group) return
    const stamp = now()
    group.deletedAt = stamp
    group.updatedAt = stamp
    for (const host of this.data.hosts) {
      if (host.groupId === groupId) {
        host.groupId = null
        host.updatedAt = stamp
      }
    }
  }

  moveGroup(groupId: string, direction: -1 | 1): void {
    const groups = this.listGroups()
    const index = groups.findIndex((group) => group.id === groupId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= groups.length) return
    const reordered = [...groups]
    const [item] = reordered.splice(index, 1)
    reordered.splice(target, 0, item!)
    reordered.forEach((group, order) => {
      const stored = this.data.groups.find((entry) => entry.id === group.id)
      if (stored) {
        stored.sortOrder = order
        stored.updatedAt = now()
      }
    })
  }

  /** Commit the group, host and optional persistence together; failures leave no partial edit. */
  saveHostWithGroup(input: HostInput, persist?: () => void): HostPublic {
    const original = this.data
    this.data = structuredClone(original)
    try {
      let groupId = input.groupId
      if (input.newGroupName !== undefined) {
        const name = cleanText(input.newGroupName, '分组名称', 40)
        if (groupId) throw new Error('不能同时指定已有分组和新分组')
        if (this.data.groups.some((group) => group.deletedAt === null && group.name === name)) {
          throw new Error('已有同名分组，请选择已有分组')
        }
        groupId = this.saveGroup({ name }).id
      }
      const result = this.saveHost({ ...input, groupId })
      persist?.()
      return result
    } catch (error) {
      this.data = original
      throw error
    }
  }

  saveHost(input: HostInput): HostPublic {
    const hostName = cleanText(input.host, '主机', 255)
    const previousHost = input.id ? this.requireHost(input.id) : undefined
    const name = hostDisplayName(previousHost && input.name === previousHost.host && input.name.length > 80 ? '' : input.name, hostName)
    const username = cleanText(input.username, '用户名', 128)
    const port = cleanPort(input.port)
    const authType = assertAuth(input.authType)
    // Validate both fields before changing any part of an existing record.
    const connectionTimeoutSec = normalizeConnectionTimeout(input.connectionTimeoutSec === undefined ? previousHost?.connectionTimeoutSec : input.connectionTimeoutSec)
    const keepaliveIntervalSec = normalizeKeepaliveInterval(input.keepaliveIntervalSec === undefined ? previousHost?.keepaliveIntervalSec : input.keepaliveIntervalSec)
    if (input.groupId && !this.data.groups.some((group) => group.id === input.groupId && group.deletedAt === null)) {
      throw new Error('分组不存在')
    }
    const persistent = input.persistent === undefined ? (input.id ? this.requireHost(input.id).persistent : false) : normalizePersistent(input.persistent)
    const forwards = normalizeForwards(input.forwards === undefined ? (input.id ? this.requireHost(input.id).forwards : []) : input.forwards)
    const previous = input.id ? this.requireHost(input.id).jumps : []
    const jumps = input.jumps === undefined ? previous : checkJumps(input.jumps ?? [])
      .map((jump, index) => normalizeJump(jump, previous[index] ?? null, this.codec))
    const stamp = now()
    if (input.id) {
      const host = this.requireHost(input.id)
      const meta = pricedHostMeta(host.meta, input.meta)
      const agent = authType === 'agent' ? normalizeAgent(input.agent === undefined ? host.agent : input.agent) : null
      host.connectionTimeoutSec = connectionTimeoutSec
      host.keepaliveIntervalSec = keepaliveIntervalSec
      host.persistent = persistent
      host.forwards = forwards
      host.groupId = input.groupId
      host.name = name
      host.host = hostName
      host.port = port
      host.username = username
      host.authType = authType
      host.agent = agent
      host.passwordEnc = applySecret(host.passwordEnc, input.password, this.codec)
      host.privateKeyEnc = applySecret(host.privateKeyEnc, input.privateKey, this.codec)
      host.privateKeyPath =
        input.privateKeyPath === undefined ? host.privateKeyPath : input.privateKeyPath?.trim() || null
      host.passphraseEnc = applySecret(host.passphraseEnc, input.passphrase, this.codec)
      host.proxy =
        input.proxy === undefined ? host.proxy : input.proxy === null ? null : normalizeProxy(input.proxy, host.proxy, this.codec)
      host.jumps = jumps
      host.startupCommand =
        input.startupCommand === undefined ? host.startupCommand : input.startupCommand?.trim() || null
      host.updatedAt = stamp
      host.meta = meta
      return toHostPublic(host)
    }
    const host: StoredHost = {
      connectionTimeoutSec,
      keepaliveIntervalSec,
      persistent,
      forwards,
      meta: pricedHostMeta(emptyHostMeta(), input.meta),
      deletedAt: null,
      id: id(),
      groupId: input.groupId,
      name,
      host: hostName,
      port,
      username,
      authType,
      agent: authType === 'agent' ? normalizeAgent(input.agent) : null,
      passwordEnc: applySecret(null, input.password, this.codec),
      privateKeyEnc: applySecret(null, input.privateKey, this.codec),
      privateKeyPath: input.privateKeyPath?.trim() || null,
      passphraseEnc: applySecret(null, input.passphrase, this.codec),
      proxy: input.proxy ? normalizeProxy(input.proxy, null, this.codec) : null,
      jumps,
      startupCommand: input.startupCommand?.trim() || null,
      createdAt: stamp,
      updatedAt: stamp
    }
    this.data.hosts.push(host)
    return toHostPublic(host)
  }

  deleteHost(hostId: string): void {
    const host = this.requireHost(hostId)
    host.deletedAt = now()
    host.updatedAt = host.deletedAt
    clearHostSecrets(host)
  }

  duplicateHost(hostId: string): HostPublic {
    const host = this.requireHost(hostId)
    const stamp = now()
    const copy: StoredHost = {
      ...structuredClone(host),
      id: id(),
      name: `${host.name} 副本`.slice(0, 80),
      createdAt: stamp,
      updatedAt: stamp
    }
    this.data.hosts.push(copy)
    return toHostPublic(copy)
  }

  settingsPublic(unlocked: boolean): SettingsPublic {
    const settings = this.data.settings
    return {
      autoCollect: settings.autoCollect,
      collectionIntervalMinutes: settings.collectionIntervalMinutes,
      verifySecrets: settings.verifySecrets,
      displayCurrency: settings.displayCurrency,
      language: settings.language,
      theme: settings.theme,
      fontSize: settings.fontSize,
      transferConcurrency: settings.transferConcurrency,
      packSmallFiles: settings.packSmallFiles,
      sidebarCollapsed: settings.sidebarCollapsed,
      backgroundStay: settings.backgroundStay,
      keystore: true,
      backup: {
        hasPassword: Boolean(settings.backup.kdf && settings.backup.verifier),
        unlocked,
        rememberUnlock: settings.backup.rememberUnlock,
        webdav: toWebdavPublic(settings.backup.webdav),
        s3: toS3Public(settings.backup.s3)
      }
    }
  }

  updateSettings(patch: SettingsPatch): void {
    if (patch.backgroundStay !== undefined && typeof patch.backgroundStay !== 'boolean') throw new Error('后台常驻设置不合法 / Invalid background setting')
    if (patch.verifySecrets !== undefined && typeof patch.verifySecrets !== 'boolean') throw new Error('身份验证设置不合法 / Invalid identity verification setting')
    if (patch.autoCollect !== undefined && typeof patch.autoCollect !== 'boolean') throw new Error('自动采集设置不合法 / Invalid automatic collection setting')
    if (patch.collectionIntervalMinutes !== undefined && normalizeCollectionInterval(patch.collectionIntervalMinutes) !== patch.collectionIntervalMinutes) {
      throw new Error('采集间隔不合法 / Invalid collection interval')
    }
    const display = patch.displayCurrency === undefined ? undefined : normalizeDisplayCurrency(patch.displayCurrency)
    const settings = this.data.settings
    if (patch.autoCollect !== undefined) settings.autoCollect = patch.autoCollect
    if (patch.collectionIntervalMinutes !== undefined) settings.collectionIntervalMinutes = patch.collectionIntervalMinutes
    if (patch.verifySecrets !== undefined) settings.verifySecrets = patch.verifySecrets
    if (display !== undefined) settings.displayCurrency = display
    if (patch.language) settings.language = patch.language
    if (patch.theme) settings.theme = patch.theme
    if (patch.fontSize !== undefined) {
      const size = Math.round(patch.fontSize)
      if (size < 11 || size > 22) throw new Error('字号超出范围')
      settings.fontSize = size
    }
    if (patch.transferConcurrency !== undefined) {
      const value = Math.round(patch.transferConcurrency)
      if (value < 1 || value > 8) throw new Error('并发数超出范围')
      settings.transferConcurrency = value
    }
    if (patch.packSmallFiles !== undefined) settings.packSmallFiles = patch.packSmallFiles
    if (patch.sidebarCollapsed !== undefined) settings.sidebarCollapsed = patch.sidebarCollapsed
    if (patch.backgroundStay !== undefined) settings.backgroundStay = patch.backgroundStay
    if (patch.rememberUnlock !== undefined) settings.backup.rememberUnlock = patch.rememberUnlock
    if (patch.webdav !== undefined) {
      settings.backup.webdav = patch.webdav ? normalizeWebdav(patch.webdav, settings.backup.webdav, this.codec) : null
    }
    if (patch.s3 !== undefined) {
      settings.backup.s3 = patch.s3 ? normalizeS3(patch.s3, settings.backup.s3, this.codec) : null
    }
  }

  setBackupUnlock(kdf: StoredKdf | null, verifier: string | null): void {
    this.data.settings.backup.kdf = kdf
    this.data.settings.backup.verifier = verifier
  }

  changeMasterPassword(reencrypt: (payload: string) => string, kdf: StoredKdf, verifier: string, remember: boolean, save: () => void): void {
    const previous = this.data
    const data = this.snapshot()
    const rotate = (payload: string | null) => payload?.startsWith('mp:') ? reencrypt(payload) : payload
    for (const host of data.hosts) {
      for (const entry of [host, ...host.jumps]) {
        entry.passwordEnc = rotate(entry.passwordEnc)
        entry.privateKeyEnc = rotate(entry.privateKeyEnc)
        entry.passphraseEnc = rotate(entry.passphraseEnc)
      }
      if (host.proxy) host.proxy.passwordEnc = rotate(host.proxy.passwordEnc)
    }
    const backup = data.settings.backup
    if (backup.webdav) backup.webdav.passwordEnc = rotate(backup.webdav.passwordEnc)
    if (backup.s3) backup.s3.secretAccessKeyEnc = rotate(backup.s3.secretAccessKeyEnc)
    for (const slots of Object.values(data.localExtensionSecrets)) {
      for (const value of Object.values(slots)) value.valueEnc = rotate(value.valueEnc)!
    }
    Object.assign(backup, { kdf, verifier, rememberUnlock: remember })
    this.data = data
    try {
      save()
    } catch (error) {
      this.data = previous
      throw error
    }
  }

  kdf(): StoredKdf | null {
    return this.data.settings.backup.kdf
  }

  verifier(): string | null {
    return this.data.settings.backup.verifier
  }

  markAutoBackup(at: number): void {
    this.data.settings.backup.lastAutoBackupAt = at
  }

  webdavPassword(): string | null {
    return decryptMaybe(this.data.settings.backup.webdav?.passwordEnc ?? null, this.codec)
  }

  s3Secret(): string | null {
    return decryptMaybe(this.data.settings.backup.s3?.secretAccessKeyEnc ?? null, this.codec)
  }

  exportPortable(exportedAt = new Date().toISOString()): PortableVault {
    return {
      kind: 'hopline-vault',
      version: 8,
      exportedAt,
      groups: this.data.groups.filter((group) => group.deletedAt === null)
        .map((group) => ({ ...toGroupPublic(group), updatedAt: group.updatedAt })),
      hosts: this.data.hosts.filter((host) => host.deletedAt === null).map((host) => this.toPortableHost(host)),
      tombstones: {
        hosts: this.data.hosts.filter((host) => host.deletedAt !== null).map(tombstoneOf),
        groups: this.data.groups.filter((group) => group.deletedAt !== null).map(tombstoneOf)
      },
      settings: this.toPortableSettings()
    }
  }

  importPortable(vault: PortableVault | PortableVaultV1, mode: 'merge' | 'replace'): void {
    const staged = new Vault(this.snapshot(), this.codec)
    staged.applyPortable(vault, mode)
    this.data = staged.data
  }

  private applyPortable(input: PortableVault | PortableVaultV1, mode: 'merge' | 'replace'): void {
    assertPortable(input)
    const vault = migratePortable(input)
    const groups: StoredGroup[] = vault.groups.filter((group) => group.id && group.name).map((group) => ({
      id: group.id, name: cleanText(group.name, '分组名称', 40), sortOrder: group.sortOrder ?? 0,
      updatedAt: validTime(group.updatedAt) ? group.updatedAt : 0, deletedAt: null
    }))
    const hosts = vault.hosts.map((host) => portableToStored(host, this.codec))
    const incomingGroups = mergeRecords(groups, vault.tombstones.groups.map(storedGroupTombstone))
    const incomingHosts = mergeRecords(hosts, vault.tombstones.hosts.map(storedHostTombstone))
    this.data.groups = mergeRecords(mode === 'replace' ? [] : this.data.groups, incomingGroups)
    this.data.hosts = mergeRecords(mode === 'replace' ? [] : this.data.hosts, incomingHosts)
    detachDeletedGroups(this.data)
    const settings = vault.settings
    this.data.settings.autoCollect = settings.autoCollect !== false
    this.data.settings.collectionIntervalMinutes = normalizeCollectionInterval(settings.collectionIntervalMinutes)
    this.data.settings.verifySecrets = this.data.settings.verifySecrets || settings.verifySecrets !== false
    this.data.settings.displayCurrency = normalizeDisplayCurrency(settings.displayCurrency)
    this.data.settings.language = settings.language === 'en' ? 'en' : 'zh'
    this.data.settings.theme =
      settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system'
    this.data.settings.fontSize = clamp(settings.fontSize, 11, 22, 13)
    this.data.settings.transferConcurrency = clamp(settings.transferConcurrency, 1, 8, 3)
    this.data.settings.packSmallFiles = Boolean(settings.packSmallFiles)
    this.data.settings.sidebarCollapsed = Boolean(settings.sidebarCollapsed)
    this.data.settings.backgroundStay = typeof settings.backgroundStay === 'boolean' ? settings.backgroundStay : true
    this.data.settings.backup.rememberUnlock = settings.rememberUnlock !== false
    this.data.settings.backup.webdav = settings.webdav
      ? {
          url: settings.webdav.url.trim(),
          username: settings.webdav.username.trim(),
          remoteDir: settings.webdav.remoteDir.trim() || 'hopline',
          passwordEnc: settings.webdav.password ? this.codec.encrypt(settings.webdav.password) : null
        }
      : null
    this.data.settings.backup.s3 = settings.s3
      ? {
          endpoint: settings.s3.endpoint.trim(),
          bucket: settings.s3.bucket.trim(),
          region: settings.s3.region.trim() || 'auto',
          accessKeyId: settings.s3.accessKeyId.trim(),
          prefix: settings.s3.prefix.trim() || 'hopline',
          forcePathStyle: Boolean(settings.s3.forcePathStyle),
          secretAccessKeyEnc: settings.s3.secretAccessKey ? this.codec.encrypt(settings.s3.secretAccessKey) : null
        }
      : null
  }

  private toPortableHost(host: StoredHost): PortableHost {
    const secrets = {
      password: decryptMaybe(host.passwordEnc, this.codec),
      privateKey: decryptMaybe(host.privateKeyEnc, this.codec),
      passphrase: decryptMaybe(host.passphraseEnc, this.codec)
    }
    return {
      connectionTimeoutSec: host.connectionTimeoutSec,
      keepaliveIntervalSec: host.keepaliveIntervalSec,
      persistent: host.persistent,
      forwards: structuredClone(host.forwards),
      id: host.id,
      groupId: host.groupId,
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      authType: host.authType,
      agent: structuredClone(host.agent),
      password: secrets.password,
      privateKey: secrets.privateKey,
      privateKeyPath: host.privateKeyPath,
      passphrase: secrets.passphrase,
      proxy: host.proxy
        ? {
            type: host.proxy.type,
            host: host.proxy.host,
            port: host.proxy.port,
            username: host.proxy.username,
            password: decryptMaybe(host.proxy.passwordEnc, this.codec)
          }
        : null,
      jumps: host.jumps.map((jump) => this.toPortableJump(jump)),
      startupCommand: host.startupCommand,
      createdAt: host.createdAt,
      updatedAt: host.updatedAt,
      meta: structuredClone(host.meta)
    }
  }

  private toPortableJump(jump: StoredJump): PortableJump {
    return {
      host: jump.host,
      port: jump.port,
      username: jump.username,
      authType: jump.authType,
      agent: structuredClone(jump.agent),
      password: decryptMaybe(jump.passwordEnc, this.codec),
      privateKey: decryptMaybe(jump.privateKeyEnc, this.codec),
      privateKeyPath: jump.privateKeyPath,
      passphrase: decryptMaybe(jump.passphraseEnc, this.codec)
    }
  }

  private toPortableSettings(): PortableSettings {
    const settings = this.data.settings
    return {
      autoCollect: settings.autoCollect,
      collectionIntervalMinutes: settings.collectionIntervalMinutes,
      verifySecrets: settings.verifySecrets,
      displayCurrency: settings.displayCurrency,
      language: settings.language,
      theme: settings.theme,
      fontSize: settings.fontSize,
      transferConcurrency: settings.transferConcurrency,
      packSmallFiles: settings.packSmallFiles,
      sidebarCollapsed: settings.sidebarCollapsed,
      backgroundStay: settings.backgroundStay,
      rememberUnlock: settings.backup.rememberUnlock,
      webdav: settings.backup.webdav
        ? {
            url: settings.backup.webdav.url,
            username: settings.backup.webdav.username,
            password: decryptMaybe(settings.backup.webdav.passwordEnc, this.codec),
            remoteDir: settings.backup.webdav.remoteDir
          }
        : null,
      s3: settings.backup.s3
        ? {
            endpoint: settings.backup.s3.endpoint,
            bucket: settings.backup.s3.bucket,
            region: settings.backup.s3.region,
            accessKeyId: settings.backup.s3.accessKeyId,
            secretAccessKey: decryptMaybe(settings.backup.s3.secretAccessKeyEnc, this.codec),
            prefix: settings.backup.s3.prefix,
            forcePathStyle: settings.backup.s3.forcePathStyle
          }
        : null
    }
  }

  private requireHost(hostId: string): StoredHost {
    const host = this.getHost(hostId)
    if (!host) throw new Error('主机不存在')
    return host
  }
}

function toWebdavPublic(webdav: StoredWebDav | null): WebDavPublic | null {
  if (!webdav) return null
  return {
    url: webdav.url,
    username: webdav.username,
    hasPassword: Boolean(webdav.passwordEnc),
    remoteDir: webdav.remoteDir
  }
}

function toS3Public(s3: StoredS3 | null): S3Public | null {
  if (!s3) return null
  return {
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    hasSecret: Boolean(s3.secretAccessKeyEnc),
    prefix: s3.prefix,
    forcePathStyle: s3.forcePathStyle
  }
}

function normalizeWebdav(input: WebDavInput, prev: StoredWebDav | null, codec: SecretCodec): StoredWebDav {
  return {
    url: cleanText(input.url, 'WebDAV 地址', 500),
    username: input.username.trim(),
    remoteDir: input.remoteDir.trim() || 'hopline',
    passwordEnc: applySecret(prev?.passwordEnc ?? null, input.password, codec)
  }
}

function normalizeS3(input: S3Input, prev: StoredS3 | null, codec: SecretCodec): StoredS3 {
  return {
    endpoint: input.endpoint.trim(),
    bucket: input.bucket.trim(),
    region: input.region.trim() || 'auto',
    accessKeyId: input.accessKeyId.trim(),
    prefix: input.prefix.trim() || 'hopline',
    forcePathStyle: Boolean(input.forcePathStyle),
    secretAccessKeyEnc: applySecret(prev?.secretAccessKeyEnc ?? null, input.secretAccessKey, codec)
  }
}

function portableToStored(host: PortableHost, codec: SecretCodec): StoredHost {
  const address = cleanText(host.host, '主机', 255)
  return {
    connectionTimeoutSec: normalizeConnectionTimeout(host.connectionTimeoutSec),
    keepaliveIntervalSec: normalizeKeepaliveInterval(host.keepaliveIntervalSec),
    persistent: normalizePersistent(host.persistent),
    forwards: normalizeForwards(host.forwards),
    id: host.id || id(),
    groupId: host.groupId ?? null,
    name: hostDisplayName(host.name, address),
    host: address,
    port: cleanPort(host.port),
    username: cleanText(host.username, '用户名', 128),
    authType: assertAuth(host.authType),
    agent: host.authType === 'agent' ? normalizeAgent(host.agent) : null,
    passwordEnc: host.password ? codec.encrypt(host.password) : null,
    privateKeyEnc: host.privateKey ? codec.encrypt(host.privateKey) : null,
    privateKeyPath: host.privateKeyPath ?? null,
    passphraseEnc: host.passphrase ? codec.encrypt(host.passphrase) : null,
    proxy: host.proxy ? portableProxyToStored(host.proxy, codec, host.name) : null,
    jumps: checkJumps(host.jumps).map((jump) => portableJumpToStored(jump, codec, host.name)),
    startupCommand: host.startupCommand ?? null,
    createdAt: validTime(host.createdAt) ? host.createdAt : now(),
    updatedAt: validTime(host.updatedAt) ? host.updatedAt : now(),
    meta: applyHostMeta(emptyHostMeta(), host.meta),
    deletedAt: null
  }
}

function portableProxyToStored(proxy: PortableProxy, codec: SecretCodec, hostName: string): StoredProxy {
  try {
    return {
      type: proxy.type === 'http' ? 'http' : 'socks5',
      host: cleanText(proxy.host, '代理主机', 255),
      port: cleanPort(proxy.port),
      username: proxy.username ?? null,
      passwordEnc: proxy.password ? codec.encrypt(proxy.password) : null
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : '配置无法识别'
    throw new Error(`主机「${hostName}」的代理配置不正确：${detail}`, { cause: error })
  }
}

function portableJumpToStored(jump: PortableJump, codec: SecretCodec, hostName: string): StoredJump {
  try {
    return {
      host: cleanText(jump.host, '跳板主机', 255),
      port: cleanPort(jump.port),
      username: cleanText(jump.username, '跳板用户', 128),
      authType: assertAuth(jump.authType),
      agent: jump.authType === 'agent' ? normalizeJumpAgent(jump.agent) : null,
      passwordEnc: jump.password ? codec.encrypt(jump.password) : null,
      privateKeyEnc: jump.privateKey ? codec.encrypt(jump.privateKey) : null,
      privateKeyPath: jump.privateKeyPath ?? null,
      passphraseEnc: jump.passphrase ? codec.encrypt(jump.passphrase) : null
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : '配置无法识别'
    throw new Error(`主机「${hostName}」的跳板配置不正确：${detail}`, { cause: error })
  }
}

export function assertPortable(value: unknown): asserts value is PortableVault | PortableVaultV1 {
  if (!value || typeof value !== 'object') throw new Error('备份内容无法识别')
  const vault = value as Partial<PortableVault | PortableVaultV1>
  if (typeof vault.version === 'number' && vault.version > 8) throw new Error('备份来自更新版本的 Hopline')
  if (vault.kind !== 'hopline-vault' || (vault.version !== 1 && vault.version !== 2 && vault.version !== 3 && vault.version !== 4 && vault.version !== 5 && vault.version !== 6 && vault.version !== 7 && vault.version !== 8)) {
    throw new Error('备份内容无法识别')
  }
  if (!Array.isArray(vault.hosts) || !Array.isArray(vault.groups) || !vault.settings) {
    throw new Error('备份内容不完整')
  }
  // Older exports can omit a group timestamp; an explicitly invalid time is not a missing one.
  if (vault.version !== 1 && vault.groups.some((group) => group && typeof group === 'object' &&
      'updatedAt' in group && group.updatedAt !== undefined && !validTime(group.updatedAt))) {
    throw new Error('备份分组时间格式不正确')
  }
  if (vault.version === 2 || vault.version === 3 || vault.version === 4 || vault.version === 5 || vault.version === 6 || vault.version === 7 || vault.version === 8) {
    const tombstones = vault.tombstones
    const valid = (entries: unknown): boolean => Array.isArray(entries) && entries.every((entry) =>
      entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.trim() &&
      validTime(entry.updatedAt) && validTime(entry.deletedAt))
    if (!tombstones || !valid(tombstones.hosts) || !valid(tombstones.groups)) {
      throw new Error('备份删除标记格式不正确')
    }
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function toGroupPublic(group: StoredGroup): HostGroup {
  return { id: group.id, name: group.name, sortOrder: group.sortOrder }
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function migratePortable(vault: PortableVault | PortableVaultV1): PortableVault {
  if (vault.version === 8) return vault
  // Unknown legacy times must not outrank local edits/deletions. Disk migration still uses its actual time.
  const { data } = migrateStore(vault, 0)
  return {
    ...vault, version: 8,
    hosts: data.hosts as unknown as PortableHost[],
    groups: data.groups.map((group) => ({ ...toGroupPublic(group), updatedAt: group.updatedAt })),
    tombstones: vault.version === 1 ? { hosts: [], groups: [] } : structuredClone(vault.tombstones)
  }
}

export function normalizeForwards(value: unknown): ForwardRule[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('端口转发最多 20 条')
  const ids = new Set<string>(), binds = new Set<string>()
  return value.map((rule) => {
    if (!rule || !['local', 'remote', 'dynamic'].includes(rule.type) || typeof rule.autoStart !== 'boolean') throw new Error('转发规则不正确')
    const id = cleanText(rule.id, '规则 ID', 128), bindHost = cleanText(rule.bindHost ?? '127.0.0.1', '绑定地址', 255)
    const bindPort = cleanPort(rule.bindPort), key = JSON.stringify([rule.type, bindHost, bindPort])
    if (ids.has(id) || binds.has(key)) throw new Error('转发规则 ID 或绑定重复')
    ids.add(id); binds.add(key)
    return { id, type: rule.type, bindHost, bindPort, autoStart: rule.autoStart,
      targetHost: rule.type === 'dynamic' ? null : cleanText(rule.targetHost, '目标地址', 255),
      targetPort: rule.type === 'dynamic' ? null : cleanPort(rule.targetPort) }
  })
}

function normalizePersistent(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('持久会话开关不合法')
  return value
}
