import type { OverviewState } from './overview'
import type { ForwardsState } from './forwards'
import type { RunbookState } from './runbook'
export interface AppState extends RunbookState { fx: import('../../../shared/fx').FxSnapshot | null }
import { useMemo, useSyncExternalStore } from 'react'
import type { HoplineApi } from '../../../shared/api'
import { createSelectorSnapshot } from '../logic/selector'
import { runbookError } from '../logic/runbook'
import type { CatalogState } from './catalog'
import type { TabsState } from './tabs'
import type { PromptsState } from './prompts'
import type { UiState } from './ui'
import type { TransfersState } from './transfers'
import type { UpdatesState } from './updates'

export { shallowEqual } from '../logic/selector'

export interface AppState extends OverviewState, CatalogState, TabsState, PromptsState, UiState, TransfersState, ForwardsState, UpdatesState {}

const initial: AppState = {
  fx: null,
  updateOpen: false, updateChecking: false, updateResult: null, updatePreferences: null,
  runbookTarget: null, opLogHost: null,
  route: { page: 'overview' },
  overviewOpen: true, snapshots: {}, collecting: [],
  forwards: [], forwardsOpen: false,
  ready: false,
  bootError: null,
  hosts: [],
  groups: [],
  settings: null,
  backup: null,
  osTheme: 'light',
  tabs: [],
  activeId: null,
  sidebarCollapsed: false,
  paletteOpen: false,
  hostDialog: false,
  settingsOpen: false,
  aboutOpen: false,
  confirm: null,
  prompts: [],
  connecting: null,
  findOpen: false,
  toasts: [],
  transfers: {},
  info: null,
  query: ''
}

let state = initial
const listeners = new Set<() => void>()

export function api(): HoplineApi {
  if (!window.hopline) throw new Error('Hopline 预加载接口不可用')
  return window.hopline
}

export function errorText(error: unknown): string {
  return runbookError(error)
}

export function getState(): AppState {
  return state
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function patch(partial: Partial<AppState> | ((state: AppState) => AppState)): void {
  const next = typeof partial === 'function' ? partial(state) : { ...state, ...partial }
  // Keep the old overview flag compatible with extensions and saved integrations.
  // All new navigation uses the explicit route; it never destroys terminal state.
  if (next.route === state.route && next.overviewOpen !== state.overviewOpen) {
    next.route = { page: next.overviewOpen ? 'overview' : 'sessions' }
  }
  next.overviewOpen = next.route.page === 'overview'
  state = next
  listeners.forEach((listener) => listener())
}

export function useAppSelector<T>(selector: (state: AppState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  // Each render's selector gets its own cache, including selectors that capture props.
  // Never mutate a shared selector ref during render: concurrent renders may differ.
  const getSnapshot = useMemo(() => createSelectorSnapshot(getState, selector, isEqual), [selector, isEqual])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** @deprecated 请用 useAppSelector 只订阅组件需要的字段。 */
export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getState, getState)
}

export interface AppState { securityHost?: string | null }
