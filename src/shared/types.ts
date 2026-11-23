export type AuthType = 'password' | 'privateKey' | 'keyboard-interactive' | 'agent'

export interface AgentConfig {
  socket: string | null
  identityFile: string | null
  forward: boolean
}

export type ProxyType = 'socks5' | 'http'

export interface ProxyInput {
  type: ProxyType
  host: string
  port: number
  username?: string | null
  /** undefined keeps the stored secret, null clears it, a string replaces it. */
  password?: string | null
}

export interface ProxyPublic {
  type: ProxyType
  host: string
  port: number
  username: string | null
  hasPassword: boolean
}

export interface JumpInput {
  agent?: AgentConfig | null
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string | null
  privateKey?: string | null
  privateKeyPath?: string | null
  passphrase?: string | null
}

export interface JumpPublic {
  agent: AgentConfig | null
  host: string
  port: number
  username: string
  authType: AuthType
  hasPassword: boolean
  hasPrivateKey: boolean
  privateKeyPath: string | null
  hasPassphrase: boolean
}

export type BillingCycle = 'monthly' | 'quarterly' | 'yearly' | 'once'

export interface HostMeta {
  provider: string | null
  price: number | null
  currency: string | null
  billingCycle: BillingCycle | null
  renewalAnchorDay?: number
  renewAt: number | null
  tags: string[]
  note: string | null
}

export interface HostInput {
  /** Undefined keeps the stored value; null restores the application default. */
  connectionTimeoutSec?: number | null
  keepaliveIntervalSec?: number | null
  /** Create this group atomically with saving the host. */
  newGroupName?: string
  forwards?: ForwardRule[]
  agent?: AgentConfig | null
  /** Omitted fields retain their current values. */
  meta?: Partial<HostMeta>
  id?: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string | null
  privateKey?: string | null
  privateKeyPath?: string | null
  passphrase?: string | null
  proxy?: ProxyInput | null
  jumps?: JumpInput[] | null
  startupCommand?: string | null
}

export interface HostPublic {
  connectionTimeoutSec: number | null
  keepaliveIntervalSec: number | null
  forwards: ForwardRule[]
  agent: AgentConfig | null
  meta: HostMeta
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  hasPassword: boolean
  hasPrivateKey: boolean
  privateKeyPath: string | null
  hasPassphrase: boolean
  proxy: ProxyPublic | null
  jumps: JumpPublic[]
  startupCommand: string | null
  createdAt: number
  updatedAt: number
}

export interface HostGroup {
  id: string
  name: string
  sortOrder: number
}

export interface GroupInput {
  id?: string
  name: string
}

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type Locale = 'zh' | 'en'

export interface WebDavInput {
  url: string
  username: string
  password?: string | null
  remoteDir: string
}

export interface WebDavPublic {
  url: string
  username: string
  hasPassword: boolean
  remoteDir: string
}

export interface S3Input {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey?: string | null
  prefix: string
  forcePathStyle: boolean
}

export interface S3Public {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  hasSecret: boolean
  prefix: string
  forcePathStyle: boolean
}

export interface BillingPreferences {
  displayCurrency: string
}

export type CollectionIntervalMinutes = 1 | 5 | 15

export interface SettingsPublic extends BillingPreferences {
  autoCollect: boolean
  collectionIntervalMinutes: CollectionIntervalMinutes
  verifySecrets: boolean
  language: Locale
  theme: ThemePreference
  fontSize: number
  transferConcurrency: number
  packSmallFiles: boolean
  sidebarCollapsed: boolean
  backgroundStay: boolean
  keystore: boolean
  backup: {
    hasPassword: boolean
    unlocked: boolean
    rememberUnlock: boolean
    webdav: WebDavPublic | null
    s3: S3Public | null
  }
}

export interface SettingsPatch {
  autoCollect?: boolean
  collectionIntervalMinutes?: CollectionIntervalMinutes
  verifySecrets?: boolean
  displayCurrency?: string
  language?: Locale
  theme?: ThemePreference
  fontSize?: number
  transferConcurrency?: number
  packSmallFiles?: boolean
  sidebarCollapsed?: boolean
  backgroundStay?: boolean
  rememberUnlock?: boolean
  webdav?: WebDavInput | null
  s3?: S3Input | null
}

export type SessionKind = 'ssh' | 'local'
export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SessionInfo {
  id: string
  kind: SessionKind
  title: string
  hostId?: string
  status: SessionStatus
  message?: string
}

export interface HostKeyPrompt {
  requestId: string
  host: string
  port: number
  fingerprint: string
  keyType: string
  mismatch: boolean
}

export interface KeyboardPrompt {
  requestId: string
  name: string
  instructions: string
  prompts: { prompt: string; echo: boolean }[]
}

export interface SftpEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtime: number
  mode: number
}

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface TransferJob {
  id: string
  sessionId: string
  hostId?: string
  direction: TransferDirection
  name: string
  localPath: string
  remotePath: string
  loaded: number
  total: number
  status: TransferStatus
  error?: string
}

export interface LocalBackup {
  name: string
  filePath: string
  bytes: number
  mtimeMs: number
}

export interface BackupStatus {
  hasPassword: boolean
  unlocked: boolean
  rememberUnlock: boolean
  lastAutoBackupAt: number | null
  autoBackupNote: string | null
}

export interface AppInfo {
  keystoreReadFailed?: boolean
  dataNotices?: { kind: 'quarantined' | 'rejected' | 'recovered' | 'recovery-failed'; path: string }[]
  name: 'Hopline'
  edition: 'community' | 'pro'
  version: string
  platform: string
  electron: string
  shots: boolean
  userData: string
  keystore: boolean
}

export type MenuCommand =
  | 'check-updates'
  | 'new-local'
  | 'new-host'
  | 'close-tab'
  | 'palette'
  | 'toggle-sidebar'
  | 'find'
  | 'settings'
  | 'about'
  | 'backup-now'

export interface PortableProxy {
  type: ProxyType
  host: string
  port: number
  username: string | null
  password: string | null
}

export interface PortableJump {
  agent: AgentConfig | null
  host: string
  port: number
  username: string
  authType: AuthType
  password: string | null
  privateKey: string | null
  privateKeyPath: string | null
  passphrase: string | null
}

export interface PortableHost {
  connectionTimeoutSec: number | null
  keepaliveIntervalSec: number | null
  forwards: ForwardRule[]
  agent: AgentConfig | null
  meta: HostMeta
  id: string
  groupId: string | null
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  password: string | null
  privateKey: string | null
  privateKeyPath: string | null
  passphrase: string | null
  proxy: PortableProxy | null
  jumps: PortableJump[]
  startupCommand: string | null
  createdAt: number
  updatedAt: number
}

export interface PortableSettings {
  autoCollect?: boolean
  collectionIntervalMinutes?: CollectionIntervalMinutes
  verifySecrets?: boolean
  displayCurrency?: string
  language: Locale
  theme: ThemePreference
  fontSize: number
  transferConcurrency: number
  packSmallFiles: boolean
  sidebarCollapsed: boolean
  /** Omitted by older v1–v8 backups; defaults to enabled on import. */
  backgroundStay?: boolean
  rememberUnlock: boolean
  webdav: {
    url: string
    username: string
    password: string | null
    remoteDir: string
  } | null
  s3: {
    endpoint: string
    bucket: string
    region: string
    accessKeyId: string
    secretAccessKey: string | null
    prefix: string
    forcePathStyle: boolean
  } | null
}

export interface PortableGroup extends HostGroup {
  updatedAt: number
}

export interface Tombstone {
  id: string
  updatedAt: number
  deletedAt: number
}

export interface PortableVault {
  kind: 'hopline-vault'
  /** v2–v7 remain accepted on import; exports use v8. */
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8
  exportedAt: string
  groups: PortableGroup[]
  hosts: PortableHost[]
  tombstones: { hosts: Tombstone[]; groups: Tombstone[] }
  settings: PortableSettings
}

/** Legacy payloads are accepted only at the import boundary. */
export interface PortableVaultV1 extends Omit<PortableVault, 'version' | 'hosts' | 'groups' | 'tombstones'> {
  version: 1
  hosts: (Omit<PortableHost, 'meta' | 'agent' | 'jumps' | 'forwards' | 'persistent' | 'connectionTimeoutSec' | 'keepaliveIntervalSec'> & { jump: PortableJump | null })[]
  groups: HostGroup[]
}

export type Section<T> =
  | { status: 'complete' | 'partial'; data: T; note?: string }
  | { status: 'unavailable'; reason: 'not-installed' | 'permission-denied' | 'not-applicable' | 'error'; note?: string }

export interface HostOs {
  id: string | null
  version: string | null
  name: string | null
  kernel: string | null
  architecture: string | null
}

export interface HostCpu {
  cores: number | null
  usagePercent: number | null
}

export interface HostMemory {
  totalBytes: number | null
  availableBytes: number | null
  swapTotalBytes: number | null
  swapUsedBytes: number | null
}

export interface HostLoad {
  one: number | null
  five: number | null
  fifteen: number | null
}

export interface HostDisk {
  filesystem: string
  mountpoint: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usagePercent: number
}

export interface HostListener {
  protocol: 'tcp' | 'tcp6'
  address: string
  port: number
  process: string | null
}

export interface HostContainer {
  name: string
  image: string
  status: string
  ports: string
}

export interface HostService {
  name: string
  description: string
}

export interface HostWeb {
  source: 'nginx' | 'caddy'
  domain: string
}

export interface HostCertificate {
  domain: string | null
  expiresAt: number | null
}

export interface HostSnapshot {
  collectedAt: number
  os: Section<HostOs>
  uptime: Section<{ seconds: number | null }>
  cpu: Section<HostCpu>
  memory: Section<HostMemory>
  load: Section<HostLoad>
  disk: Section<HostDisk[]>
  listeners: Section<HostListener[]>
  docker: Section<HostContainer[]>
  services: Section<HostService[]>
  web: Section<HostWeb[]>
  certs: Section<HostCertificate[]>
}

export interface Snippet {
  id: string
  name: string
  command: string
  hostId: string | null
  createdAt: number
  updatedAt: number
}

export type SnippetInput = Pick<Snippet, 'name' | 'command' | 'hostId'> & { id?: string }

export interface ImportCandidate extends HostInput {
  jumps: JumpInput[]
  jumpNames: string[]
  warnings: string[]
  duplicateOf: string | null
}

export interface SshConfigPreview {
  hosts: ImportCandidate[]
  warnings: string[]
}

export interface CollectRecord {
  needsAttention?: boolean
  snapshot: HostSnapshot | null
  error: string | null
  updatedAt: number | null
}
export type CollectRecords = Record<string, CollectRecord>

export interface ForwardRule {
  id: string
  type: 'local' | 'remote' | 'dynamic'
  bindHost: string
  bindPort: number
  targetHost: string | null
  targetPort: number | null
  autoStart: boolean
}

export interface ForwardStatus {
  hostId: string
  ruleId: string
  state: 'running' | 'stopped' | 'error'
  error?: string
  connections: number
}

import type { StepResult, RunbookPlan } from '../core/runbook/types'
export interface OpLogEntry extends StepResult {
  at: number
  runbookId: string
  /** Original preview and per-item measured release; absent in older records. */
  cleanup?: { estimatedBytes: number | null; actualBytes: number | null }
}
export interface RunbookPreview extends RunbookPlan { id: string }
export interface RunbookProgress { hostId: string; planId: string; result: StepResult }

export const MASTER_PASSWORD_REQUIRED = '系统钥匙串不可用：请先在设置 › 备份里设置并解锁主密码，才能保存密码或私钥'

export class LockedError extends Error {
  constructor() {
    super(MASTER_PASSWORD_REQUIRED)
    this.name = 'LockedError'
  }
}

export interface HostCertificate { unreferenced?: boolean }
export interface HostSnapshot { securityScore?: number }
export interface CollectRecord { securityScore?: number }
export type { SecuritySnapshot, SecurityResult, SecurityReport, SecurityIgnores } from '../core/security/types'

export interface InitAuth { type: 'privateKey' | 'agent'; privateKeyPath?: string; socket?: string; passphrase?: string }
export interface InitIdentity { label: string; publicKey: string; auth: InitAuth }

export interface RunbookPreview { cleanup?: Record<string, import('../core/runbook/cleanup').CleanupEstimate> }
export interface RunbookProgress { cleanup?: import('../core/runbook/cleanup').CleanupChange }

export interface SessionInfo { shellHostname?: string }
export interface CleanupDuResult { output: string; timedOut: boolean; truncated: boolean; incomplete: boolean }
// Extension interface. The community edition exposes single-host manual runs.
export interface CleanupSchedule { hostId: string; selected: string[]; intervalHours: number }
export interface CleanupBatch { hostIds: string[]; selected: string[] }

export interface HostInput { persistent?: boolean }
export interface HostPublic { persistent: boolean }
export interface PortableHost { persistent: boolean }
export interface PersistentOptions { persistent?: boolean; tmuxName?: string }
export interface PersistentSession { name: string; activity: number; attached: number }
export interface SessionInfo { tmuxName?: string; tmuxMissing?: boolean }
export interface TaskNotification { title: string; body: string }
