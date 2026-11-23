import type { SessionInfo } from '../../../shared/types'

export type LayoutTab = { kind: 'ssh'; hostId: string; tmuxName?: string } | { kind: 'local' }
export interface Layout {
  tabs: LayoutTab[]
  activeIndex: number
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function parseLayout(raw: string | null): Layout | null {
  try {
    const value: unknown = JSON.parse(raw ?? '')
    if (!hasKeys(value, ['tabs', 'activeIndex']) || !Array.isArray(value.tabs)) return null
    if (!value.tabs.every((tab: unknown) =>
      (hasKeys(tab, ['kind']) && tab.kind === 'local') ||
      ((hasKeys(tab, ['kind', 'hostId']) || (hasKeys(tab, ['kind', 'hostId', 'tmuxName']) && typeof tab.tmuxName === 'string' && /^hopline-[a-zA-Z0-9]{6}$/.test(tab.tmuxName))) && tab.kind === 'ssh' && typeof tab.hostId === 'string' && tab.hostId.trim().length > 0)
    )) return null
    const index = value.activeIndex
    if (typeof index !== 'number' || !Number.isInteger(index)) return null
    if (value.tabs.length ? index < 0 || index >= value.tabs.length : index !== -1) return null
    return value as unknown as Layout
  } catch {
    return null
  }
}

export function serializeLayout(tabs: readonly Pick<SessionInfo, 'id' | 'kind' | 'hostId' | 'tmuxName'>[], activeId: string | null): string {
  const valid = tabs.filter((tab) => tab.kind === 'local' || tab.hostId?.trim())
  const activeIndex = valid.length ? Math.max(0, valid.findIndex((tab) => tab.id === activeId)) : -1
  return JSON.stringify({
    tabs: valid.map((tab) => tab.kind === 'local' ? { kind: 'local' } : { kind: 'ssh', hostId: tab.hostId, ...(tab.tmuxName ? { tmuxName: tab.tmuxName } : {}) }),
    activeIndex
  })
}
