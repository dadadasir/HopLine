import type { TransferJob } from '../../../shared/types'
import { translate } from '../i18n'
import { localeOf } from './catalog'
import { api, errorText, patch } from './store'
import { toast } from './ui'

export interface EditSyncEvent {
  sessionId: string
  remotePath: string
  error?: string
  conflict?: boolean
  recoveredPath?: string
}

export interface TransfersState {
  transfers: Record<string, TransferJob[]>
}

export function upsertTransfer(job: TransferJob): void {
  patch((current) => {
    const list = current.transfers[job.sessionId] ?? []
    const next = list.some((item) => item.id === job.id) ? list.map((item) => (item.id === job.id ? job : item)) : [...list, job]
    return { ...current, transfers: { ...current.transfers, [job.sessionId]: next } }
  })
}

export function notifyEditSync(payload: EditSyncEvent): void {
  const name = payload.remotePath.split('/').pop() || payload.remotePath
  let text = payload.conflict
    ? translate(localeOf(), 'toast.editConflict', { name })
    : payload.error || translate(localeOf(), payload.recoveredPath ? 'toast.editNotSynced' : 'toast.synced', { name })
  const recoveredPath = payload.recoveredPath
  if (recoveredPath) text += '\n' + translate(localeOf(), 'toast.editRecovered', { path: recoveredPath })
  toast(text, payload.conflict || recoveredPath ? 'warning' : payload.error ? 'err' : 'ok', {
    // Recovery actions remain available until explicitly dismissed.
    duration: recoveredPath ? 0 : payload.conflict ? 15000 : undefined,
    action: recoveredPath ? {
      label: translate(localeOf(), api().platform === 'darwin' ? 'toast.showInFinder' : 'toast.showInFolder'),
      run: () => api().shell.showItem(recoveredPath)
    } : undefined
  })
}


/** Fill the initial history without overwriting events received during the request. */
export function loadTransferSnapshot(sessionId?: string, onError: (error: unknown) => void = (error) => toast(errorText(error), 'err')): () => void {
  let active = true
  let listening = true
  const updated = new Set<string>()
  const off = api().on('transfer:event', (job: TransferJob) => updated.add(job.id))
  const stopListening = () => { if (listening) { listening = false; off() } }
  void api().sftp.jobs(sessionId).then((rows) => {
    if (active) rows.filter((row) => !updated.has(row.id)).forEach(upsertTransfer)
  }).catch((error) => { if (active) onError(error) }).finally(stopListening)
  return () => { active = false; stopListening() }
}
