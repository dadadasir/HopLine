import type { UpdateCheckResult, UpdatePreferences, UpdateRelease } from '../../../shared/updates'
import { api, getState, patch } from './store'

export interface UpdatesState {
  updateOpen: boolean
  updateChecking: boolean
  updateResult: UpdateCheckResult | null
  updatePreferences: UpdatePreferences | null
}

export async function checkForUpdates(): Promise<void> {
  patch({ updateOpen: true })
  if (getState().updateChecking) return
  patch({ updateChecking: true, updateResult: null })
  try {
    const result = await api().updates.check()
    patch({ updateResult: result ?? { status: 'error', reason: 'unavailable' } })
  } catch {
    patch({ updateResult: { status: 'error', reason: 'unavailable' } })
  } finally {
    patch({ updateChecking: false })
  }
}

export function updateAvailable(release: UpdateRelease): void {
  patch({ updateResult: { status: 'available', release }, updateOpen: true })
}
