import type { CleanupDiagnostics } from '../../../core/cleanup/diagnostics'
import { cleanupSize } from '../logic/cleanup'
import { Meter, toneColor } from './Gauge'
import { useT } from './ui'

export function CleanupDiagnosticCards({ diagnostics }: { diagnostics: CleanupDiagnostics }) {
  const t = useT(), { deleted, inodes, logs } = diagnostics
  const unavailable = (name: string, reason: string) => <div className="scroll-mt-14 rounded-lg border border-line p-3" data-cleanup-diagnostic={name}>
    <h4 className="font-medium">{t(`cleanup.diagnostic.${name}`)}</h4>
    <p className="mt-1 text-[12px] text-muted">{t('cleanup.diagnostic.unavailable')} · {t(reason)}</p>
  </div>
  return <div className="space-y-3" data-cleanup-diagnostics>
    {deleted.status === 'unavailable' ? unavailable('deleted', deleted.reason) : deleted.data.files.length > 0 && <div className="scroll-mt-14 space-y-3 rounded-lg border border-line p-3" data-cleanup-diagnostic="deleted">
      <h4 className="flex flex-wrap justify-between gap-2 font-medium"><span>{t('cleanup.diagnostic.deleted')}</span><span className="font-mono">{cleanupSize(deleted.data.totalBytes)}</span></h4>
      <ul className="space-y-2">{deleted.data.files.map((file, index) => <li key={index} className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
        <span className="min-w-0 break-all font-mono">{file.process} · PID {file.pid}</span><span className="font-mono">{cleanupSize(file.bytes)}</span>
      </li>)}</ul>
      <p className="text-[12px] text-muted">{t('cleanup.ui.deletedAdvice')}</p>
    </div>}
    {inodes.status === 'unavailable' ? unavailable('inodes', inodes.reason) : inodes.data.some(disk => disk.usagePercent > 80) && <div className="scroll-mt-14 space-y-3 rounded-lg border border-line p-3" data-cleanup-diagnostic="inodes">
      <h4 className="font-medium">{t('cleanup.diagnostic.inodes')}</h4>
      {inodes.data.filter(disk => disk.usagePercent > 80).map((disk, index) => <div key={index} className="space-y-1.5"><div className="flex flex-wrap justify-between gap-2 font-mono text-[12px]"><span className="break-all">{disk.mountpoint}</span><span style={{ color: toneColor[disk.usagePercent > 95 ? 'bad' : 'warn'] }}>{disk.usagePercent}% · {disk.used} / {disk.total}</span></div><Meter value={disk.usagePercent} tone={disk.usagePercent > 95 ? 'bad' : 'warn'} /></div>)}
      <p className="text-[12px] text-muted">{t('cleanup.ui.inodeAdvice')}</p>
    </div>}
    {inodes.status === 'available' && !!inodes.unavailableMounts?.length && <div className="rounded-lg border border-line p-3 text-[12px] text-muted">{t('cleanup.diagnostic.inodeUnsupported')} · <span className="break-all font-mono">{inodes.unavailableMounts.join('、')}</span></div>}
    {logs.status === 'unavailable' ? unavailable('logs', logs.reason) : logs.data.length > 0 && <div className="scroll-mt-14 space-y-3 rounded-lg border border-line p-3" data-cleanup-diagnostic="logs">
      <h4 className="font-medium">{t('cleanup.diagnostic.logs')}</h4>
      <ol className="space-y-3">{logs.data.map((file, index) => <li key={index} className="space-y-1.5 text-[12px]"><div className="flex flex-wrap justify-between gap-2"><span className="min-w-0 break-all font-mono">{file.path}</span><span className="shrink-0 font-mono">{cleanupSize(file.bytes)}</span></div><div className="flex items-center gap-3"><div className="min-w-0 flex-1"><Meter value={logs.data[0].bytes ? file.bytes / logs.data[0].bytes * 100 : 0} tone="none" className="h-1" /></div><span className="text-[11px] text-muted">{t(file.rotated ? 'cleanup.diagnostic.rotated' : 'cleanup.diagnostic.current')}</span></div></li>)}</ol>
    </div>}
  </div>
}
