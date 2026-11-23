import type { HostSecretField } from './host-secrets'
import type { CollectRecord, CollectRecords } from './types'
import type {
  AppInfo,
  BackupStatus,
  GroupInput,
  HostGroup,
  HostInput,
  SshConfigPreview,
  HostPublic,
  LocalBackup,
  ResolvedTheme,
  SessionInfo,
  SettingsPatch,
  SettingsPublic,
  SftpEntry,
  TransferJob
} from './types'
import type { ForwardStatus, Snippet, SnippetInput } from './types'
import type { ProEvent } from '../ext/api'

export const hopEvents = [
  'app:capabilities',
  'updates:available',
  'fx:updated',
  'hosts:clearRevealed',
  'runbook:progress',
  'collect:updated',
  'forwards:status',
  'ssh:data',
  'ssh:status',
  'pty:data',
  'pty:exit',
  'hostkey:prompt',
  'kbd:prompt',
  'transfer:event',
  'theme:changed',
  'store:changed',
  'menu:command',
  'edit:synced',
  'pro:event',
  'prompt:expired',
  'notify:activate',
  'watchdog:ping',
  'window:maximized'
] as const

export type HopEvent = (typeof hopEvents)[number]

export interface VersionChange { previous: string; current: string }

export interface HoplineApi {
  fx: { read: () => Promise<import('./fx').FxSnapshot> }
  updates: {
    preferences: () => Promise<import('./updates').UpdatePreferences>
    setAutomatic: (enabled: boolean) => Promise<import('./updates').UpdatePreferences>
    check: () => Promise<import('./updates').UpdateCheckResult | null>
    openRelease: (url: string) => Promise<void>
  }
  forwards: {
    list: () => Promise<ForwardStatus[]>
    start: (hostId: string, ruleId: string) => Promise<void>
    stop: (hostId: string, ruleId: string) => Promise<void>
  }
  runbook: {
    plan: (hostId: string, runbookId: string, params: import('../core/runbook/types').Params, sudoPassword?: string, requestId?: string) => Promise<import('./types').RunbookPreview>
    run: (hostId: string, planId: string, selected: string[], sudoPassword?: string) => Promise<import('../core/runbook/types').RunbookSummary>
    cancel: (hostId: string, planId?: string) => Promise<void>
  }
  oplog: { list: (hostId: string) => Promise<import('./types').OpLogEntry[]> }
  snippets: {
    list: () => Promise<Snippet[]>
    save: (input: SnippetInput) => Promise<Snippet>
    delete: (id: string) => Promise<void>
  }
  platform: string
  pro: {
    invoke: (name: string, ...args: unknown[]) => Promise<unknown>
    on: (listener: (event: ProEvent) => void) => () => void
  }
  hosts: {
    importSshConfig: {
      preview: () => Promise<SshConfigPreview>
      apply: (hosts: HostInput[], groupId: string | null) => Promise<{ success: number; failed: number }>
    }
    list: () => Promise<HostPublic[]>
    save: (input: HostInput) => Promise<HostPublic>
    delete: (id: string) => Promise<void>
    copyConnectionCard: (id: string) => Promise<void>
    copySecret: (id: string, field: HostSecretField) => Promise<void>
    revealSecret: (id: string, field: HostSecretField) => Promise<string>
    duplicate: (id: string) => Promise<HostPublic>
  }
  groups: {
    list: () => Promise<HostGroup[]>
    save: (input: GroupInput) => Promise<HostGroup>
    delete: (id: string) => Promise<void>
    move: (id: string, direction: -1 | 1) => Promise<void>
  }
  settings: {
    get: () => Promise<SettingsPublic>
    update: (patch: SettingsPatch) => Promise<SettingsPublic>
  }
  ssh: {
    connect: (input: { hostId: string; cols: number; rows: number } & import('./types').PersistentOptions) => Promise<SessionInfo>
    reconnect: (sessionId: string, cols: number, rows: number) => Promise<SessionInfo>
    disconnect: (sessionId: string) => Promise<void>
    write: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    respondHostKey: (requestId: string, decision: 'reject' | 'once' | 'save') => Promise<void>
    respondKeyboard: (requestId: string, answers: string[] | null) => Promise<void>
  }
  pty: {
    open: (cols: number, rows: number) => Promise<SessionInfo>
    write: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    close: (sessionId: string) => Promise<void>
  }
  sftp: {
    /** Open reusable host-owned file access without starting a terminal shell. */
    openHost: (hostId: string) => Promise<string>
    list: (sessionId: string, path?: string) => Promise<{ path: string; entries: SftpEntry[] }>
    mkdir: (sessionId: string, path: string) => Promise<void>
    rename: (sessionId: string, from: string, to: string) => Promise<void>
    remove: (sessionId: string, path: string) => Promise<void>
    upload: (sessionId: string, localPaths: string[], remoteDir: string) => Promise<void>
    download: (sessionId: string, remotePath: string, localDir: string) => Promise<void>
    cancel: (jobId: string) => Promise<void>
    edit: (sessionId: string, remotePath: string) => Promise<{ localPath: string }>
    jobs: (sessionId?: string) => Promise<TransferJob[]>
  }
  backup: {
    changePassword: (current: string, next: string, remember: boolean) => Promise<BackupStatus>
    status: () => Promise<BackupStatus>
    setPassword: (password: string, remember: boolean) => Promise<BackupStatus>
    unlock: (password: string, remember: boolean) => Promise<BackupStatus>
    lock: () => Promise<BackupStatus>
    auto: () => Promise<string | null>
    export: (filePath: string, password: string | null) => Promise<string>
    import: (filePath: string, password: string | null, mode: 'merge' | 'replace') => Promise<void>
    list: () => Promise<LocalBackup[]>
    webdav: (direction: 'push' | 'pull', password: string | null, mode: 'merge' | 'replace', requestId: string) => Promise<void>
    cancelWebdav: (requestId: string) => Promise<void>
  }
  dialog: {
    pick: (kind: 'files' | 'directory' | 'key') => Promise<string[]>
    saveBackup: () => Promise<string | null>
    openBackup: () => Promise<string | null>
  }
  clipboard: {
    read: () => Promise<string>
    write: (text: string) => Promise<void>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
    showItem: (filePath: string) => Promise<void>
  }
  window: {
    minimize: () => Promise<void>
    zoom: () => Promise<void>
    isMaximized: () => Promise<boolean>
    close: () => Promise<void>
  }
  app: {
    capabilities: () => Promise<import('../ext/capabilities').EditionCapabilities>
    versionChange: () => Promise<VersionChange | null>
    info: () => Promise<AppInfo>
    relaunch: () => Promise<void>
    theme: () => Promise<ResolvedTheme>
  }
  getPathForFile: (file: File) => string
  on: (channel: HopEvent, listener: (payload: any) => void) => () => void
  captureShot: (name: string) => Promise<string>
}

export interface HoplineApi {
  collect: {
    run: (hostId: string, authenticated?: boolean) => Promise<CollectRecord>
    latest: () => Promise<CollectRecords>
    overview: (open: boolean) => Promise<void>
  }
}

export interface HoplineApi {
  security: {
    check: (hostId: string, options?: { sudoPassword?: string }) => Promise<import('./types').SecurityReport>
    latest: (hostId: string) => Promise<import('./types').SecurityReport | null>
    ignore: (hostId: string, ruleId: string, note: string) => Promise<import('./types').SecurityReport>
    unignore: (hostId: string, ruleId: string) => Promise<import('./types').SecurityReport>
    share: (hostId: string, options?: { host?: boolean }) => Promise<string | null>
  }
}

export interface HoplineApi {
  init: {
    identities: () => Promise<import('./types').InitIdentity[]>
    plan: (hostId: string, params: import('../core/runbook/types').Params, auth: import('./types').InitAuth) => Promise<import('./types').RunbookPreview>
  }
}

export interface HoplineApi {
  watchdog: { pong: (id: number) => void; sessions: () => Promise<SessionInfo[]> }
  diagnostics: { preview: () => Promise<string>; save: (preview: string) => Promise<boolean> }
  cleanup: {
    disk: (hostId: string, mount: string) => Promise<import('./types').HostDisk | null>
    diagnose: (hostId: string, sudoPassword?: string, requestId?: string) => Promise<import('../core/cleanup/diagnostics').CleanupDiagnostics>
    du: (hostId: string, mount: string, requestId?: string) => Promise<import('./types').CleanupDuResult>
    sudo: (hostId: string, requestId?: string) => Promise<import('../core/runbook/types').SudoMode>
  }
}

export interface HoplineApi {
  persistent: {
    list: (hostId: string) => Promise<import('./types').PersistentSession[]>
    kill: (hostId: string, name: string) => Promise<void>
  }
  notify: (sessionId: string, message: import('./types').TaskNotification, activeId: string | null, enabled: boolean) => Promise<boolean>
}
