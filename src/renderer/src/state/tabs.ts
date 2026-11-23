import type { PersistentOptions, TaskNotification } from '../../../shared/types'
import type { TaskProgress } from '../logic/progress'
import { shouldNotify } from '../logic/notify'
import type { HostPublic, SessionInfo } from '../../../shared/types'
import { detachTerminal, terminalOf } from '../terminal/registry'
import { parseLayout, serializeLayout } from '../logic/layout'
import { api, errorText, getState, patch, subscribe } from './store'
import { toast } from './ui'
import { refreshHost } from './overview'
import { isLockedError } from '../logic/locked-error'
import { isKeystoreReadError } from '../../../shared/host-secrets'

export interface TabState extends SessionInfo {
  tmuxNoticeDismissed?: boolean
  unread?: boolean
  agent?: string
  progress?: TaskProgress | null
  sftpOpen: boolean
}

export interface TabsState {
  unlockPending?: { id: string; retry: () => Promise<unknown> }[]
  tabs: TabState[]
  activeId: string | null
  connecting: string | null
}

export function upsertTab(info: SessionInfo, sftpOpen = false, activate = true): void {
  patch((current) => {
    const existing = current.tabs.find((tab) => tab.id === info.id)
    const tab = { ...existing, ...info, sftpOpen: existing?.sftpOpen ?? sftpOpen }
    const tabs = existing ? current.tabs.map((item) => (item.id === info.id ? tab : item)) : [...current.tabs, tab]
    return { ...current, tabs, activeId: activate ? info.id : current.activeId, ...(activate ? { route: { page: 'sessions' as const } } : {}) }
  })
}

export async function connectHost(host: HostPublic, options: PersistentOptions = {}, restoring = false, collectAfterConnect = false): Promise<SessionInfo | undefined> {
  patch({ connecting: host.name, paletteOpen: false })
  try {
    const info = await api().ssh.connect({ hostId: host.id, cols: 100, rows: 32, ...options })
    patch({ connecting: null })
    upsertTab(info)
    if (collectAfterConnect) void refreshHost(host.id, true)
    return info
  } catch (error) {
    patch({ connecting: null })
    if (isLockedError(error)) {
      queueUnlock(host.id, () => connectHost(host, options, restoring, collectAfterConnect))
      return
    }
    const message = errorText(error)
    if (!(restoring && getState().info?.keystoreReadFailed && isKeystoreReadError(message))) toast(message, 'err')
  }
}

export async function openLocal(): Promise<SessionInfo | undefined> {
  patch({ paletteOpen: false })
  try {
    const info = await api().pty.open(100, 32)
    upsertTab(info)
    return info
  } catch (error) {
    toast(errorText(error), 'err')
  }
}

export async function closeTab(id: string): Promise<void> {
  const tab = getState().tabs.find((item) => item.id === id)
  if (!tab) return
  try {
    if (tab.kind === 'ssh') await api().ssh.disconnect(id)
    else await api().pty.close(id)
  } catch (error) {
    // The session still exists in the main process; keep the tab so closing can be retried.
    toast(errorText(error), 'err')
    return
  }
  // The terminal pane may still be loading and have no unmount cleanup yet.
  // Clear its queued output only after the main process confirms the close.
  if (!terminalOf(id)) detachTerminal(id)
  patch((current) => {
    const tabs = current.tabs.filter((item) => item.id !== id)
    const activeId = current.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : current.activeId
    const transfers = { ...current.transfers }
    delete transfers[id]
    return { ...current, tabs, activeId, transfers }
  })
}

export async function reconnectTab(id: string): Promise<void> {
  try {
    const term = terminalOf(id)
    const info = await api().ssh.reconnect(id, term?.cols ?? 100, term?.rows ?? 32)
    upsertTab(info)
  } catch (error) {
    if (isLockedError(error)) {
      queueUnlock(id, () => reconnectTab(id))
      return
    }
    toast(errorText(error), 'err')
  }
}

export function queueUnlock(id: string, retry: () => Promise<unknown>): void {
  patch((state) => ({ ...state, unlockPending: [...(state.unlockPending ?? []).filter((item) => item.id !== id), { id, retry }] }))
}

export async function unlockConnections(password: string): Promise<void> {
  const backup = await api().backup.unlock(password, false)
  const pending = getState().unlockPending ?? []
  patch({ backup, unlockPending: [] })
  for (const item of pending) await item.retry()
}

const layoutKey = 'hopline.layout.v1'
const restoreKey = 'hopline.layout.restore'
let layoutRestored = false

export function restoreLayoutEnabled(): boolean {
  try {
    const value = localStorage.getItem(restoreKey)
    return value === null || value === 'true'
  } catch {
    return false
  }
}

export function setRestoreLayoutEnabled(enabled: boolean): void {
  try { localStorage.setItem(restoreKey, String(enabled)) } catch { /* Storage is optional. */ }
}

export async function restoreLayout(): Promise<void> {
  if (!getState().ready || layoutRestored) return
  layoutRestored = true
  if (getState().tabs.length || !restoreLayoutEnabled()) return
  let layout
  try { layout = parseLayout(localStorage.getItem(layoutKey)) } catch { return }
  if (!layout) return
  const restored: (string | undefined)[] = []
  for (const tab of layout.tabs) {
    if (tab.kind === 'local') restored.push((await openLocal())?.id)
    else {
      const host = getState().hosts.find((host) => host.id === tab.hostId)
      restored.push(host ? (await connectHost(host, { tmuxName: tab.tmuxName }, true))?.id : undefined)
    }
  }
  const activeId = restored[layout.activeIndex] ?? restored.find((id) => id !== undefined)
  if (activeId && getState().tabs.some((tab) => tab.id === activeId)) patch({ activeId })
}

export function watchLayout(): () => void {
  const snapshot = () => serializeLayout(getState().tabs, getState().activeId)
  let previous = snapshot()
  let pending: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    if (pending === undefined) return
    try { localStorage.setItem(layoutKey, pending) } catch { /* Storage is optional. */ }
    pending = undefined
  }
  const unsubscribe = subscribe(() => {
    const next = snapshot()
    if (next === previous) return
    previous = pending = next
    clearTimeout(timer)
    timer = setTimeout(flush, 250)
  })
  if (getState().tabs.length) {
    pending = previous
    timer = setTimeout(flush, 250)
  }
  window.addEventListener('beforeunload', flush)
  return () => {
    unsubscribe()
    window.removeEventListener('beforeunload', flush)
    flush()
  }
}

export function updateTask(id: string, change: Partial<Pick<TabState, 'agent' | 'unread' | 'progress' | 'tmuxNoticeDismissed'>>): void {
  patch((state) => ({ ...state, tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, ...change } : tab) }))
}
export function taskNotificationsEnabled(): boolean {
  try { return localStorage.getItem('hopline.taskNotifications') !== 'false' } catch { return true }
}
export function setTaskNotificationsEnabled(enabled: boolean): void {
  try { localStorage.setItem('hopline.taskNotifications', String(enabled)) } catch { /* Storage is optional. */ }
}
export function taskIsBackground(id: string): boolean {
  return shouldNotify(true, getState().activeId === id && getState().route.page === 'sessions', document.hasFocus())
}
export function notifyTask(id: string, message: TaskNotification): void {
  if (!taskNotificationsEnabled() || !taskIsBackground(id)) return
  const activeId = getState().route.page !== 'sessions' ? null : getState().activeId
  void api().notify(id, message, activeId, true).then((accepted) => {
    if (accepted && taskIsBackground(id)) updateTask(id, { unread: true })
  }).catch(() => undefined)
}
export function watchTaskNotifications(): () => void {
  const clear = () => {
    const state = getState(), tab = state.tabs.find((item) => item.id === state.activeId)
    if (state.route.page === 'sessions' && document.hasFocus() && tab?.unread) updateTask(tab.id, { unread: false })
  }
  const off = subscribe(clear)
  window.addEventListener('focus', clear)
  const activate = api().on('notify:activate', (id: string) => {
    if (getState().tabs.some((tab) => tab.id === id)) { updateTask(id, { unread: false }); patch({ activeId: id, route: { page: 'sessions' } }) }
  })
  return () => { off(); activate(); window.removeEventListener('focus', clear) }
}
