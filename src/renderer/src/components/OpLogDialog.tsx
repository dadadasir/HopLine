import { localDateTime } from '../../../core/reminders'
import { runbookError } from '../logic/runbook'
import { cleanupSize } from '../logic/cleanup'
import { useEffect, useState } from 'react'
import type { OpLogEntry } from '@shared/types'
import { api, patch, useAppSelector } from '../state'
import { Modal, useT } from './ui'

export function OpLogDialog() {
  const hostId = useAppSelector((state) => state.opLogHost)
  return hostId ? <Entries key={hostId} hostId={hostId} /> : null
}
function Entries({ hostId }: { hostId: string }) {
  const t = useT(), host = useAppSelector((state) => state.hosts.find((item) => item.id === hostId))
  const [rows, setRows] = useState<OpLogEntry[]>([]), [filter, setFilter] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    void api().oplog.list(hostId).then((items) => { if (active) setRows(items.reverse()) }).catch((err) => { if (active) setError(runbookError(err)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [hostId])
  return <Modal open title={`${t('runbook.log')} · ${host?.name ?? hostId}`} onClose={() => patch({ opLogHost: null })} width="w-[720px]">
    <div className="max-h-[70vh] space-y-3 overflow-auto text-[13px]">
      <select aria-label={t('runbook.filter')} value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">{t('runbook.filter')}</option>{[...new Set(rows.map((row) => row.runbookId))].map((id) => <option key={id} value={id}>{id}</option>)}</select>
      {loading ? <p>{t('runbook.loading')}</p> : !rows.length && <p>{t('overview.empty')}</p>}
      {rows.filter((row) => !filter || row.runbookId === filter).map((row, index) => <div key={index} className="space-y-1 rounded border border-line p-3">
        <p>{localDateTime(row.at)} · {t(row.title)} · {t(`runbook.${row.status}`)} · {row.durationMs} ms</p>
        <p>{row.runbookId === 'cleanup' && /^bytes=\d+$/.test(row.reason) ? t('cleanup.already') : row.reason.split('；').map((part) => t(part)).join(' · ')}</p>
        {row.cleanup && <p className="font-mono text-[12px] text-muted" data-cleanup-measurements>
          {t('cleanup.estimate', { size: row.cleanup.estimatedBytes === null ? t('cleanup.unknown') : cleanupSize(row.cleanup.estimatedBytes) })}
          {' · '}{t('cleanup.itemReleased', { size: row.cleanup.actualBytes === null ? t('cleanup.unknown') : cleanupSize(row.cleanup.actualBytes) })}
        </p>}
        {row.output && <details><summary>{t('runbook.output')}</summary><pre className="whitespace-pre-wrap break-all font-mono text-[12px]">{row.output}</pre></details>}
      </div>)}
      {error && <p role="alert" className="text-red-600 dark:text-red-300">{t(error)}</p>}
    </div>
  </Modal>
}
