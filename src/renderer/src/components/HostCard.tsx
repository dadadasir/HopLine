import { RefreshCw, Terminal } from 'lucide-react'
import type { CollectRecord, HostPublic, Locale } from '@shared/types'
import { healthScore } from '../../../core/health'
import { formatCell, sectionNote, updatedAgo } from '../logic/overview'
import { collectionUnknown, resourceValues, snapshotIsStale, type HostIssue } from '../logic/host-workspace'
import { Meter, Ring, StatusDot, scoreTone, toneColor, usageTone, type Tone } from './Gauge'
import { useT } from './ui'

/** One host at a glance: a status dot, the health ring and three usage bars. Numbers stay secondary. */
export function HostCard({ host, record, issues, busy, now, locale, intervalMinutes, onOpen, onRefresh, onConnect, onEdit }: {
  host: HostPublic; record?: CollectRecord; issues: HostIssue[]; busy: boolean; now: number; locale: Locale; intervalMinutes?: number
  onOpen: () => void; onRefresh: () => void; onConnect: () => void; onEdit: () => void
}) {
  const t = useT(), zh = locale === 'zh'
  const stale = snapshotIsStale(record, now, intervalMinutes)
  const snapshot = record?.snapshot ?? null
  const unknown = collectionUnknown(record, now, intervalMinutes)
  const health = snapshot ? healthScore(snapshot, host.meta, now, record?.securityScore) : null
  const metrics = resourceValues(record && { ...record, error: null })
  const state: Tone = record?.needsAttention ? 'warn' : record?.error ? 'bad' : issues.some((issue) => issue.level === 'bad') ? 'bad' : issues.length ? 'warn' : unknown ? 'none' : 'ok'
  const score = unknown ? null : health?.score ?? null
  const stateText = record?.needsAttention ? t('collection.attention') : record?.error ? t('collection.failed') : stale ? updatedAgo(record?.updatedAt ?? null, now, locale) : issues.length ? zh ? `${issues.length} 项需要处理` : `${issues.length} to review` : unknown ? snapshot ? null : t('overview.never') : zh ? '运行正常' : 'Healthy'
  const uptime = snapshot?.uptime.status === 'unavailable' ? null : snapshot?.uptime.data.seconds ?? null
  const load = snapshot?.load.status === 'unavailable' ? null : snapshot?.load.data.one ?? null
  const containers = snapshot?.docker.status === 'unavailable' ? null : snapshot?.docker.data.length ?? null
  const meters = [['CPU', metrics.cpu, snapshot?.cpu], [t('overview.memory'), metrics.memory, snapshot?.memory], [t('overview.disk'), metrics.disk, snapshot?.disk]] as const
  const facts = [
    uptime === null ? null : `${zh ? '已运行' : 'up'} ${formatCell('seconds', uptime, locale)}`,
    load === null ? null : `${zh ? '负载' : 'load'} ${load}`,
    containers ? `${zh ? '容器' : 'docker'} ${containers}` : null
  ].filter(Boolean)
  return <article className="group relative flex cursor-pointer flex-col gap-4 rounded-xl border border-line bg-panel p-4 transition-colors hover:border-accent/50" onClick={onOpen}>
    <header className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><StatusDot tone={state} pulse={busy} /><button className="min-w-0 truncate text-left text-[14px] font-semibold hover:text-accent" onClick={(event) => { event.stopPropagation(); onOpen() }}>{host.name}</button></div>
        <p className="mt-1 truncate font-mono text-[11px] text-muted">{host.username}@{host.host}</p>
        {stateText && <p data-snapshot-stale={stale || undefined} className="mt-2 text-xs" style={{ color: toneColor[state] }}>{stateText}</p>}
        {record?.needsAttention && <button type="button" className="mt-1 text-xs font-medium text-accent hover:underline" onClick={event => { event.stopPropagation(); onConnect() }}>{t('collection.confirm')}</button>}
        {record?.error && !record.needsAttention && <p className="mt-1 break-words text-xs text-muted">{t(record.error)}</p>}
      </div>
      <Ring value={score} tone={scoreTone(score)} size={52} stroke={5} label={`${t('overview.health')} ${score ?? '—'}`}>
        <span className="font-mono text-[15px] font-medium leading-none" title={t('overview.health')}>{score ?? '—'}</span>
      </Ring>
    </header>
    {snapshot ? <div className="space-y-2.5">
      {meters.map(([label, value, section]) => <div key={label} title={sectionNote(section, locale)} className="grid grid-cols-[3rem_1fr_2.75rem] items-center gap-2 text-xs">
        <span className="text-muted">{label}</span>
        <Meter value={value} tone={unknown ? 'none' : usageTone(value)} />
        <span className="text-right font-mono" style={{ color: unknown || usageTone(value) === 'ok' || value === null ? undefined : toneColor[usageTone(value)] }}>{value === null ? '—' : `${value.toFixed(0)}%`}</span>
        {section && section.status !== 'complete' && <span className="col-span-3 text-[11px] text-muted">{sectionNote(section, locale, !zh)}</span>}
      </div>)}
    </div> : null}
    <footer className="mt-auto flex items-center gap-2 border-t border-line pt-3 text-[11px] text-muted">
      <span className="min-w-0 flex-1 truncate font-mono">{facts.length ? facts.join(' · ') : snapshot && !stale ? updatedAgo(record?.updatedAt ?? null, now, locale) : ''}</span>
      {facts.length > 0 && !stale && <span className="shrink-0">{updatedAgo(record?.updatedAt ?? null, now, locale)}</span>}
      <span className="flex shrink-0 gap-0.5" onClick={(event) => event.stopPropagation()}>
        {!snapshot && <button className="rounded px-1.5 py-1 hover:bg-accent-soft hover:text-accent" onClick={onEdit}>{zh ? '编辑连接' : 'Edit connection'}</button>}
        <button aria-label={t('overview.refresh')} title={t(busy ? 'overview.collecting' : 'overview.refresh')} disabled={busy} className="grid h-6 w-6 place-items-center rounded hover:bg-accent-soft hover:text-accent" onClick={onRefresh}><RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /></button>
        <button aria-label={t('overview.connect')} title={t('overview.connect')} className="grid h-6 w-6 place-items-center rounded hover:bg-accent-soft hover:text-accent" onClick={onConnect}><Terminal className="h-3.5 w-3.5" /></button>
      </span>
    </footer>
  </article>
}
