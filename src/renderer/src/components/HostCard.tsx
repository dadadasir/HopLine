import { RefreshCw, Terminal } from 'lucide-react'
import type { CollectRecord, HostPublic, Locale } from '@shared/types'
import { healthScore } from '../../../core/health'
import { formatCell, sectionNote, updatedAgo } from '../logic/overview'
import { collectionUnknown, resourceValues, snapshotIsStale, type HostIssue } from '../logic/host-workspace'
import { Meter, Ring, StatusDot, scoreTone, toneColor, usageTone, type Tone } from './Gauge'
import { useT } from './ui'

function shortUptime(seconds: number, zh: boolean): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return zh ? `${days}天` : `${days}d`
  return zh ? `${hours}时${minutes}分` : `${hours}h${minutes}m`
}

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
  const loadData = snapshot?.load.status === 'unavailable' ? null : snapshot?.load.data ?? null
  const load = loadData?.one ?? null
  const containers = snapshot?.docker.status === 'unavailable' ? null : snapshot?.docker.data.length ?? null
  const meters = [['CPU', metrics.cpu, snapshot?.cpu], [t('overview.memory'), metrics.memory, snapshot?.memory], [t('overview.disk'), metrics.disk, snapshot?.disk]] as const
  const factItems = [
    uptime === null ? null : { key: 'uptime', label: zh ? '已运行' : 'up', value: shortUptime(uptime, zh), title: formatCell('seconds', uptime, locale) },
    load === null ? null : { key: 'load', label: zh ? '负载' : 'load', value: String(load), title: loadData ? `${zh ? '负载 (1/5/15 分钟)' : 'Load (1/5/15m)'} ${loadData.one} / ${loadData.five} / ${loadData.fifteen}` : undefined },
    containers ? { key: 'docker', label: zh ? '容器' : 'docker', value: String(containers), title: zh ? `运行中容器 ${containers} 个` : `${containers} containers` } : null
  ].filter((item): item is { key: string; label: string; value: string; title: string | undefined } => item !== null)
  const freshness = updatedAgo(record?.updatedAt ?? null, now, locale)
  const updatedTitle = record?.updatedAt ? new Date(record.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : undefined
  const refreshTitle = snapshot && !stale
    ? `${t(busy ? 'overview.collecting' : 'overview.refresh')} · ${freshness}${updatedTitle ? ` (${updatedTitle})` : ''}`
    : t(busy ? 'overview.collecting' : 'overview.refresh')
  return <article className="@container group relative flex cursor-pointer flex-col gap-4 rounded-xl border border-line bg-panel p-4 transition-colors hover:border-accent/50" onClick={onOpen}>
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
    <footer data-card-footer className="mt-auto flex items-center gap-2 border-t border-line pt-3 text-[11px] text-muted">
      <span data-card-facts className="min-w-0 flex-1 truncate tabular-nums">
        {factItems.length > 0
          ? factItems.map((item, index) => <span key={item.key} title={item.title}>{index > 0 ? ' · ' : ''}{item.label} <span className="font-mono">{item.value}</span></span>)
          : snapshot && !stale ? <span title={updatedTitle}>{freshness}</span> : ''}
      </span>
      {factItems.length > 0 && !stale && <span data-card-updated className="hidden shrink-0 @[310px]:inline" title={updatedTitle}>{freshness}</span>}
      <span className="flex shrink-0 gap-0.5" onClick={(event) => event.stopPropagation()}>
        {!snapshot && <button className="rounded px-1.5 py-1 hover:bg-accent-soft hover:text-accent" onClick={onEdit}>{zh ? '编辑连接' : 'Edit connection'}</button>}
        <button aria-label={t('overview.refresh')} title={refreshTitle} disabled={busy} className="grid h-6 w-6 place-items-center rounded hover:bg-accent-soft hover:text-accent" onClick={onRefresh}><RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /></button>
        <button aria-label={t('overview.connect')} title={t('overview.connect')} className="grid h-6 w-6 place-items-center rounded hover:bg-accent-soft hover:text-accent" onClick={onConnect}><Terminal className="h-3.5 w-3.5" /></button>
      </span>
    </footer>
  </article>
}
