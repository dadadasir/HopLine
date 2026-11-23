import type { AppInfo, BackupStatus, HostGroup, HostPublic, ResolvedTheme, SettingsPublic } from '../../../shared/types'
import { translate } from '../i18n'
import { api, errorText, getState, patch } from './store'
import { toast } from './ui'

export interface CatalogState {
  ready: boolean
  bootError: string | null
  hosts: HostPublic[]
  groups: HostGroup[]
  settings: SettingsPublic | null
  backup: BackupStatus | null
  osTheme: ResolvedTheme
  info: AppInfo | null
}

export function localeOf(current = getState()): 'zh' | 'en' {
  return current.settings?.language ?? 'zh'
}

export function themeOf(current = getState()): ResolvedTheme {
  const preference = current.settings?.theme ?? 'system'
  return preference === 'system' ? current.osTheme : preference
}

export async function reloadCatalog(): Promise<void> {
  const bridge = api()
  const [hosts, groups, settings, backup] = await Promise.all([
    bridge.hosts.list(),
    bridge.groups.list(),
    bridge.settings.get(),
    bridge.backup.status()
  ])
  patch({
    hosts,
    groups,
    settings,
    backup,
    sidebarCollapsed: settings.sidebarCollapsed
  })
}

export async function backupNow(): Promise<void> {
  try {
    const name = await api().backup.auto()
    if (name === null) {
      patch({ settingsOpen: 'backup' })
      toast(translate(localeOf(), 'backup.unavailable'), 'warning', { duration: 8000 })
    } else {
      toast(translate(localeOf(), 'toast.backupFile', { name }))
    }
  } catch (error) {
    toast(translate(localeOf(), 'toast.backupError', { error: errorText(error) }), 'err')
    return
  }
  try {
    patch({ backup: await api().backup.status() })
  } catch (error) {
    // A failed status refresh does not mean the backup itself failed.
    toast(errorText(error), 'err')
  }
}
