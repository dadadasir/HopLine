import type { ForwardStatus } from '@shared/types'
import { api, errorText, patch } from './store'
import { toast } from './ui'

export interface ForwardsState { forwards: ForwardStatus[]; forwardsOpen: boolean }
export async function toggleForward(hostId: string, ruleId: string, running: boolean): Promise<void> {
  try { await api().forwards[running ? 'stop' : 'start'](hostId, ruleId) }
  catch (error) { toast(errorText(error), 'err') }
}
export function subscribeForwards(): () => void {
  let active = true, received = false
  const off = api().on('forwards:status', (forwards: ForwardStatus[]) => { received = true; patch({ forwards }) })
  void api().forwards.list().then((forwards) => { if (active && !received) patch({ forwards }) }).catch((error) => toast(errorText(error), 'err'))
  return () => { active = false; off() }
}
