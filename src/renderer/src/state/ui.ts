import type { WorkspaceRoute } from './navigation'
import type { HostPublic } from '../../../shared/types'
import { api, errorText, getState, patch } from './store'

export interface ConfirmState {
  title: string
  body: string
  details?: { label: string; body: string }
  confirm: string
  danger?: boolean
  run: () => Promise<void>
}

export interface ToastOptions {
  duration?: number
  action?: { label: string; run: () => Promise<void> }
}

export interface UiState {
  route: WorkspaceRoute
  snippetPrompt?: { command: string; sessionId: string } | null
  importSshConfigOpen?: boolean
  sidebarCollapsed: boolean
  paletteOpen: boolean
  hostDialog: HostPublic | null | 'new' | 'recognize' | false
  settingsOpen: false | 'appearance' | 'transfer' | 'backup' | `pro:${string}` | 'snippets'
  aboutOpen: boolean
  confirm: ConfirmState | null
  findOpen: boolean
  toasts: { id: number; text: string; tone: 'ok' | 'err' | 'warning'; action?: ToastOptions['action'] }[]
  query: string
  diagnosticsOpen?: boolean
}

let toastSeq = 1

export function dismissToast(id: number): void {
  patch((current) => ({ ...current, toasts: current.toasts.filter((item) => item.id !== id) }))
}

export function toast(text: string, tone: 'ok' | 'err' | 'warning' = 'ok', options: ToastOptions = {}): void {
  const id = toastSeq++
  patch((current) => ({ ...current, toasts: [...current.toasts, { id, text, tone, action: options.action }] }))
  if (options.duration !== 0) setTimeout(() => dismissToast(id), options.duration ?? 2600)
}

export function toggleSidebar(): void {
  const collapsed = !getState().sidebarCollapsed
  patch({ sidebarCollapsed: collapsed, paletteOpen: false })
  void api().settings.update({ sidebarCollapsed: collapsed }).then(settings => patch({ settings })).catch(error => {
    if (getState().sidebarCollapsed === collapsed) patch({ sidebarCollapsed: !collapsed })
    toast(errorText(error), 'err')
  })
}
