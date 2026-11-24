import { localDateTime } from '../../../core/reminders'
import type { ReactNode } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import type { CollectRecord, HostPublic, HostSnapshot, Locale, Section } from '@shared/types'
import { formatCell, sectionNote, updatedAgo } from '../logic/overview'
import { resourceValues, snapshotIsStale, snapshotSections, type HostIssue } from '../logic/host-workspace'
import { refreshHost } from '../state'
import { openCleanup } from '../state/runbook'
import { Chip, Meter, Ring, toneColor, usageTone } from './Gauge'
import { QuietButton, useT } from './ui'

const inventoryKeys = ['docker', 'listeners', 'services', 'web', 'certs'] as const
const data = <T,>(section: Section<T> | undefined): T | null => !section || section.status === 'unavailable' ? null : section.data

/** Status page: the three resources as rings, system facts as chips, and the inventory folded away until asked for. */
export function HostStatus({ host, record, issues, busy, now, locale, intervalMinutes, onIssue }: {
  host: HostPublic; record?: CollectRecord; issues: HostIssue[]; busy: boolean; now: number; locale: Locale; intervalMinutes?: number; onIssue: (issue: HostIssue) => void
}) {
  const t = useT(), zh = locale === 'zh'
  const snapshot = record?.snapshot
  const stale = snapshotIsStale(record, now, intervalMinutes)
  const size = (bytes: number | null | undefined) => bytes == null ? '—' : formatCell('totalBytes', bytes, locale)
  const actionLabel = (issue: HostIssue) => issue.section === 'maintenance' ? (zh ? '去清理 →' : 'Clean up →') : issue.section === 'security' ? (zh ? '查安全 →' : 'Security →') : issue.section === 'assets' ? (zh ? '看资产 →' : 'Assets →') : (zh ? '查看 →' : 'Review →')
  return <>
    <div className={`mb-5 flex flex-wrap items-center gap-3 text-xs text-muted ${snapshot ? 'justify-between' : 'justify-end'}`}>{snapshot && <span title={localDateTime(snapshot.collectedAt)}>{updatedAgo(snapshot.collectedAt, now, locale)}</span>}<QuietButton disabled={busy} onClick={() => void refreshHost(host.id)}><RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />{t(busy ? 'overview.collecting' : 'overview.refresh')}</QuietButton></div>
    {issues.length > 0 && <div className="mb-5 divide-y divide-line rounded-xl border border-line">{issues.map((issue) => <button key={issue.key} className="flex w-full flex-wrap items-center gap-3 p-3 text-left text-[13px] hover:bg-accent-soft" onClick={() => onIssue(issue)}><span style={{ color: `var(--${issue.level === 'bad' ? 'risk' : 'warn'}-fg)` }}>{issue.title}</span><span className="flex-1 font-mono text-xs text-muted">{issue.detail}</span><span className="text-accent">{actionLabel(issue)}</span></button>)}</div>}
    {snapshot ? <Body host={host} record={record!} snapshot={snapshot} locale={locale} size={size} historical={stale || !!record?.error} /> : <p className="py-8 text-center text-sm text-muted">{t('overview.never')}</p>}
  </>
}

function Body({ host, record, snapshot, locale, size, historical }: { host: HostPublic; record: CollectRecord; snapshot: HostSnapshot; locale: Locale; size: (bytes: number | null | undefined) => string; historical: boolean }) {
  const t = useT(), zh = locale === 'zh', id = (key: string) => `${host.id}-section-${key}`
  const metrics = resourceValues({ ...record, error: null })
  const os = data(snapshot.os), cpu = data(snapshot.cpu), memory = data(snapshot.memory), load = data(snapshot.load), uptime = data(snapshot.uptime)?.seconds ?? null
  const disks = [...(data(snapshot.disk) ?? [])].sort((a, b) => b.usagePercent - a.usagePercent), fullest = disks[0]
  const used = memory?.totalBytes != null && memory.availableBytes != null ? memory.totalBytes - memory.availableBytes : null
  const swap = memory?.swapTotalBytes && memory.swapUsedBytes != null ? 100 * memory.swapUsedBytes / memory.swapTotalBytes : null
  const rings: { key: string; label: string; value: number | null; detail: string; section: Section<unknown> }[] = [
    { key: 'cpu', label: 'CPU', value: metrics.cpu, section: snapshot.cpu, detail: cpu?.cores ? zh ? `${cpu.cores} 核` : `${cpu.cores} cores` : '—' },
    { key: 'memory', label: t('overview.memory'), value: metrics.memory, section: snapshot.memory, detail: used === null ? '—' : `${size(used)} / ${size(memory?.totalBytes)}` },
    { key: 'disk', label: t('overview.disk'), value: metrics.disk, section: snapshot.disk, detail: fullest ? `${size(fullest.usedBytes)} / ${size(fullest.totalBytes)}` : '—' }
  ]
  const inventory = snapshotSections(snapshot).filter((item) => (inventoryKeys as readonly string[]).includes(item.key))
  return <div className="space-y-5">
    <section className="grid-dots overflow-hidden rounded-xl border border-line bg-panel">
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0" title={sectionNote(snapshot.os, locale)}>
          <p className="eyebrow">{t('overview.os')}</p>
          <h2 className="mt-1 truncate text-lg font-semibold">{os?.name || os?.id || (zh ? '系统信息不可用' : 'System unavailable')}{os?.version && !os.name?.includes(os.version) ? ` ${os.version}` : ''}</h2>
          <p className="mt-1 truncate font-mono text-xs text-muted">{[os?.kernel, os?.architecture].filter(Boolean).join(' · ') || sectionNote(snapshot.os, locale, !zh) || '—'}</p>
          <div className="mt-4 flex flex-wrap items-center gap-2" id={id('load')}>
            <span id={id('uptime')} className="inline-flex"><Chip label={zh ? '已运行' : 'up'} title={sectionNote(snapshot.uptime, locale)}>{uptime === null ? '—' : formatCell('seconds', uptime, locale)}</Chip></span>
            <Chip label={zh ? '负载' : 'load'} title={`${zh ? '1 / 5 / 15 分钟平均负载' : '1 / 5 / 15 minute load average'}${sectionNote(snapshot.load, locale) ? ` · ${sectionNote(snapshot.load, locale)}` : ''}`}>{load ? [load.one, load.five, load.fifteen].map((value) => value ?? '—').join(' / ') : '—'}</Chip>
            {Boolean(memory?.swapTotalBytes) && <Chip label={zh ? '交换空间' : 'swap'} title={`${size(memory?.swapUsedBytes)} / ${size(memory?.swapTotalBytes)}`}><span style={{ color: !historical && swap !== null && swap > 50 ? toneColor.warn : undefined }}>{swap === null ? '—' : `${swap.toFixed(0)}%`}</span></Chip>}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 sm:gap-8">{rings.map((ring) => <div key={ring.key} id={id(ring.key === 'disk' ? 'disk-ring' : ring.key)} className="flex scroll-mt-4 flex-col items-center text-center" title={sectionNote(ring.section, locale)}>
          <Ring value={ring.value} tone={historical ? 'none' : usageTone(ring.value)} size={104} stroke={9} label={`${ring.label} ${ring.value === null ? '—' : `${ring.value.toFixed(0)}%`}`}>
            <span><span className="font-mono text-[22px] font-medium leading-none">{ring.value === null ? '—' : ring.value.toFixed(0)}</span>{ring.value !== null && <span className="ml-0.5 font-mono text-[11px] text-muted">%</span>}</span>
          </Ring>
          <p className="mt-2.5 text-[13px] font-medium">{ring.label}</p>
          <p className="mt-0.5 max-w-[9rem] truncate font-mono text-[11px] text-muted">{sectionNote(ring.section, locale, !zh) || ring.detail}</p>
        </div>)}</div>
      </div>
    </section>

    <section id={id('disk')} className="scroll-mt-4 rounded-xl border border-line bg-panel p-5">
      <h2 className="text-sm font-semibold">{zh ? '磁盘分区' : 'Filesystems'}</h2>
      {sectionNote(snapshot.disk, locale) && <p className="mt-1 text-xs text-muted" title={sectionNote(snapshot.disk, locale)}>{sectionNote(snapshot.disk, locale, !zh)}</p>}
      {disks.length ? <div className="mt-4 space-y-3.5">{disks.map((disk) => <div key={`${disk.filesystem}:${disk.mountpoint}`} className="grid grid-cols-[minmax(5rem,11rem)_1fr_auto] items-center gap-3 text-xs">
        <span className="truncate font-mono" title={disk.filesystem}>{disk.mountpoint}</span>
        <Meter value={disk.usagePercent} tone={historical ? 'none' : usageTone(disk.usagePercent)} className="h-2" />
        <span className="whitespace-nowrap text-right font-mono text-muted"><span className="text-ink" style={{ color: historical || usageTone(disk.usagePercent) === 'ok' ? undefined : toneColor[usageTone(disk.usagePercent)] }}>{disk.usagePercent}%</span> · {size(disk.usedBytes)} / {size(disk.totalBytes)}</span>
      </div>)}{fullest && fullest.usagePercent > 80 && <button className="text-xs text-accent" onClick={() => openCleanup(host.id)}>{zh ? '分析可清理的空间 →' : 'Analyze reclaimable space →'}</button>}</div> : <p className="mt-3 text-xs text-muted">{snapshot.disk.status === 'unavailable' ? '—' : t('overview.empty')}</p>}
    </section>

    <section>
      <h2 className="mb-2 text-sm font-semibold">{zh ? '这台机器在跑什么' : 'What is running here'}</h2>
      <div className="divide-y divide-line rounded-xl border border-line bg-panel">{inventory.map(({ key, section, rows, columns }) => <Fold key={key} id={id(key)} label={t(`overview.${key}`)} count={section.status === 'unavailable' ? null : rows.length} note={sectionNote(section, locale, !zh)} description={sectionNote(section, locale)}>
        {rows.length > 0 ? <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{columns.map((column) => <th key={column} className="border-b border-line px-4 py-2 font-normal text-muted">{t(`overview.field.${column}`)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column} className="border-b border-line px-4 py-2 align-top font-mono last:border-0">{formatCell(column, row[column], locale)}</td>)}</tr>)}</tbody></table></div> : <p className="px-4 pb-3 text-xs text-muted">{section.status === 'unavailable' ? sectionNote(section, locale, !zh) || '—' : t('overview.empty')}</p>}
      </Fold>)}</div>
    </section>
  </div>
}

function Fold({ id, label, count, note, description, children }: { id: string; label: string; count: number | null; note: string; description: string; children: ReactNode }) {
  return <details id={id} className="group scroll-mt-4">
    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-[13px] hover:bg-accent-soft/40">
      <ChevronRight className="h-3.5 w-3.5 text-muted transition-transform group-open:rotate-90" />
      <span className="font-medium">{label}</span>
      {note && <span className="min-w-0 flex-1 truncate text-xs text-muted" title={description}>{note}</span>}
      <span className={`ml-auto rounded-md px-2 py-0.5 font-mono text-xs ${count ? 'bg-accent-soft text-accent' : 'text-muted'}`}>{count ?? '—'}</span>
    </summary>
    {children}
  </details>
}
