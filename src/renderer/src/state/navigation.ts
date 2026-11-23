import { patch } from './store'

export type HostSection = 'status' | 'security' | 'maintenance' | 'files' | 'assets'
export type WorkspaceRoute =
  | { page: 'overview' | 'billing' | 'sessions' | 'activity' | 'settings' | 'help' }
  | { page: 'extension'; id: string }
  | { page: 'host'; hostId: string; section: HostSection }

export function navigate(route: WorkspaceRoute): void {
  patch({ route, paletteOpen: false })
}
export function openHost(hostId: string, section: HostSection = 'status'): void {
  navigate({ page: 'host', hostId, section })
}
export function openSessions(activeId?: string): void {
  patch({ route: { page: 'sessions' }, ...(activeId ? { activeId } : {}), paletteOpen: false })
}

export function openExtension(id: string): void {
  navigate({ page: 'extension', id })
}
