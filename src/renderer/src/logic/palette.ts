import type { ForwardRule, ForwardStatus, HostPublic } from '@shared/types'

interface PaletteHost {
  id: string
  name: string
  host: string
  username: string
}

interface PaletteAction {
  id: string
  label: string
  keywords?: string[]
  matches?: (query: string) => boolean
  run: () => void
}

export type PaletteItem<H, A> =
  | { kind: 'host'; id: string; host: H }
  | { kind: 'action'; id: string; action: A }

export function paletteItems<H extends PaletteHost, A extends PaletteAction>(
  hosts: readonly H[], actions: readonly A[], query: string
): PaletteItem<H, A>[] {
  const q = query.trim().toLowerCase()
  return [
    ...hosts.filter((host) => `${host.name} ${host.host} ${host.username}`.toLowerCase().includes(q))
      .map((host) => ({ kind: 'host' as const, id: `host:${host.id}`, host })),
    ...actions.filter((action) => action.matches ? action.matches(q) : `${action.label} ${(action.keywords ?? []).join(' ')}`.toLowerCase().includes(q))
      .map((action) => ({ kind: 'action' as const, id: `action:${action.id}`, action }))
  ]
}

/** Clamp at either end; -1 represents an empty list. */
export function moveSelection(index: number, direction: -1 | 0 | 1, count: number): number {
  if (count <= 0) return -1
  return Math.max(0, Math.min(count - 1, index + direction))
}

export function overviewAction(label: string, run: () => void): PaletteAction {
  return { id: 'overview', label, keywords: ['overview', '总览'], run }
}
export function forwardLabel(rule: ForwardRule): string {
  return `${rule.type[0]!.toUpperCase()} ${rule.bindHost}:${rule.bindPort}${rule.type === 'dynamic' ? ' SOCKS5' : ` → ${rule.targetHost}:${rule.targetPort}`}`
}
export function forwardActions(hosts: HostPublic[], statuses: ForwardStatus[], t: (key: string) => string,
  toggle: (hostId: string, ruleId: string, running: boolean) => Promise<void>): PaletteAction[] {
  return hosts.flatMap((host) => host.forwards.map((rule) => {
    const running = statuses.some((item) => item.hostId === host.id && item.ruleId === rule.id && item.state === 'running')
    return { id: `forward:${host.id}:${rule.id}`, label: `${t(running ? 'forward.stop' : 'forward.start')}：${host.name} ${forwardLabel(rule)}`,
      run: () => { void toggle(host.id, rule.id, running) } }
  }))
}

export function diagnosticsAction(label: string, run: () => void): PaletteAction {
  return { id: 'diagnostics', label, keywords: ['diagnostics', '诊断'], run }
}

export function shellOutputActions(active: boolean, label: string, run: () => void): PaletteAction[] {
  return active ? [{ id: 'shell-output', label, run }] : []
}

export function persistentActions(hosts: HostPublic[], tabs: import('@shared/types').SessionInfo[], t: (key: string) => string,
  open: (host: HostPublic) => void, list: (host: HostPublic) => void, kill: (hostId: string, name: string) => void): PaletteAction[] {
  return [
    ...hosts.flatMap((host) => [
      { id: `persistent:open:${host.id}`, label: `${t('persistent.open')}：${host.name}`, run: () => open(host) },
      { id: `persistent:list:${host.id}`, label: `${t('persistent.list')} ${host.name}`, run: () => list(host) }
    ]),
    ...tabs.filter((tab) => tab.hostId && tab.tmuxName && !tab.tmuxMissing).map((tab) => ({
      id: `persistent:kill:${tab.id}`, label: `${t('persistent.kill')}：${tab.tmuxName}`, run: () => kill(tab.hostId!, tab.tmuxName!)
    }))
  ]
}
