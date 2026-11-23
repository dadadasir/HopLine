import type { HostPublic, HostGroup, Snippet, OpLogEntry } from '../shared/types'
import type { SudoMode } from '../core/runbook/types'
import type { EditionCapabilities } from './capabilities'
import type { BackgroundCollection, ExtensionObservations } from './observations'

export interface ExtensionRuntime { windowOpen: boolean; backgroundStay: boolean }
export interface ExtensionSecrets {
  has(slot: string): boolean
  get(slot: string): string | null
  set(slot: string, value: string | null): void
}

export type Edition = 'community' | 'pro'
export type Text = { zh: string; en: string }
export type ProEvent = { type: string; payload: unknown }

export interface MainExtension {
  id: string
  setup(ctx: MainExtContext): void | Promise<void>
}

export interface MainExtContext {
  edition: 'pro'
  version: string
  language(): 'zh' | 'en'
  userData: string
  /** Accepts a short name or pro:<name>; other namespaces are rejected. */
  handle(name: string, handler: (...args: unknown[]) => unknown): void
  emit(type: string, payload: unknown): void
  /** Public snapshots only; modifying them cannot change the vault. */
  listHosts(): HostPublic[]
  listGroups(): HostGroup[]
  listSnippets(): Snippet[]
  sudoMode(hostId: string): Promise<SudoMode>
  execute(hostId: string, request: ExtensionCommand): Promise<ExtensionCommandResult>
  appendOperation(hostId: string, row: OpLogEntry): void
  setCapabilities(value: EditionCapabilities): void
  /** Optional for extensions built against earlier hosts; secrets never cross public IPC. */
  secrets?: ExtensionSecrets
  collect?(hostId: string): Promise<BackgroundCollection>
  observations?(): ExtensionObservations
  onObservations?(listener: (value: ExtensionObservations) => void): () => void
  runtime?(): ExtensionRuntime
  onRuntime?(listener: (value: ExtensionRuntime) => void): () => void
  openMainWindow?(): void
  /** Disposal never starts new work and must clear in-memory secrets. */
  onDispose(callback: () => void): void
  log: { info(message: string): void; error(message: string, error?: unknown): void }
}

export interface ExtensionCommand {
  command: string
  sudo: boolean
  sudoPassword?: string
  timeoutMs: number
  maxOutputBytes?: number
}
export interface ExtensionCommandResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

export interface RendererExtension {
  id: string
  sidebarItems?: { id: string; label: Text; icon?: string; open(): void }[]
  settingsPages?: { id: string; label: Text; render(): unknown }[]
  pages?: { id: string; label: Text; render(): unknown }[]
  paletteActions?: { id: string; label: Text; keywords?: string[]; run(): void | Promise<void> }[]
}
