import type { CollectRecords } from '@shared/types'
import { api, errorText, getState, patch } from './store'
import { toast } from './ui'

export interface OverviewState {
  overviewOpen: boolean
  snapshots: CollectRecords
  collecting: string[]
}
export function openOverview(): void { patch({ route: { page: 'overview' }, paletteOpen: false }) }
export function watchOverview(): () => void {
  let updated = false, stopped = false
  const off = api().on('collect:updated', (snapshots: CollectRecords) => { updated = true; patch({ snapshots }) })
  void api().collect.latest().then((snapshots) => { if (!stopped && !updated) patch({ snapshots }) }).catch((error) => toast(errorText(error), 'err'))
  return () => { stopped = true; off() }
}
export async function refreshHost(hostId: string, authenticated = false): Promise<void> {
  if (getState().collecting.includes(hostId)) return
  patch({ collecting: [...getState().collecting, hostId] })
  try { await (authenticated ? api().collect.run(hostId, true) : api().collect.run(hostId)) }
  catch (error) { if (!authenticated) toast(errorText(error), 'err') }
  finally { patch({ collecting: getState().collecting.filter((id) => id !== hostId) }) }
}
