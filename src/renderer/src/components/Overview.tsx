import { useEffect, useState } from 'react'
import { isKeystoreReadError, KEYSTORE_UNREADABLE } from '../../../shared/host-secrets'
import { ArrowRight, Plus, RefreshCw } from 'lucide-react'
import { billingSummary } from '../../../core/billing'
import { displayCurrency, secondaryCurrency } from '../../../core/currency'
import { effectiveRenewAt, REMINDER_WINDOW_DAYS } from '../../../core/reminders'
import { convertAmount } from '../../../core/billing'
import { localDate } from '../../../core/reminders'
import { navigate } from '../state/navigation'
import { costSummary } from '../../../core/health'
import { money } from '../logic/overview'
import { useRendererCapabilities } from '../ext/capabilities'
import { collectionNeedsUpdate, collectionUnknown, hostIssues, type HostSection } from '../logic/host-workspace'
import { HostCard } from './HostCard'
import { toneColor, type Tone } from './Gauge'
import { api, connectHost, errorText, refreshHost, shallowEqual, toast, useAppSelector, patch, openHost } from '../state'
import { PrimaryButton, QuietButton, useT } from './ui'

export function Overview({ onOpenHost }: { onOpenHost?: (hostId: string, section?: HostSection) => void }) {
  const state = useAppSelector((s) => ({ hosts: s.hosts, snapshots: s.snapshots, collecting: s.collecting, locale: s.settings?.language ?? 'zh', settings: s.settings, fx: s.fx }), shallowEqual)
  const [now, setNow] = useState(Date.now)
  const keystoreReadFailed = useAppSelector(s => s.info?.keystoreReadFailed === true)
  const [relaunching, setRelaunching] = useState(false)
  const t = useT(), zh = state.locale === 'zh'
  const summary = costSummary(state.hosts, now)
  const { overviewHostLimit } = useRendererCapabilities()
  const overviewHosts = state.hosts.slice(0, overviewHostLimit)
  const remainingHosts = state.hosts.slice(overviewHostLimit)
  const collecting = state.collecting.some(id => overviewHosts.some(host => host.id === id))
  const intervalMinutes = state.settings?.collectionIntervalMinutes
  const rows = overviewHosts.map((host) => ({ host, record: state.snapshots[host.id], issues: hostIssues(host, state.snapshots[host.id], now, state.locale, intervalMinutes), unknown: collectionUnknown(state.snapshots[host.id], now, intervalMinutes) }))
  const pending = rows.flatMap((row) => row.issues.map((issue) => ({ ...row, issue }))).sort((a, b) => Number(b.issue.level === 'bad') - Number(a.issue.level === 'bad'))
  const unknown = rows.filter((row) => row.unknown)
  const updates = unknown.filter(row => collectionNeedsUpdate(row.record, now, intervalMinutes)).length
  const needs = rows.filter((row) => row.issues.length).length
  const healthy = rows.filter((row) => !row.unknown && !row.issues.length).length
  const title = !state.hosts.length ? zh ? '添加第一台主机' : 'Add your first host'
    : needs ? zh ? `${needs} 台主机需要处理` : `${needs} hosts need attention`
    : unknown.length ? zh ? '主机状态' : 'Host status'
    : zh ? '已采集的状态暂无已知问题' : 'No known issues in collected status'
  const target = displayCurrency(state.settings?.displayCurrency, state.locale)
  const billing = billingSummary(state.hosts, target, state.fx, now)
  const secondary = secondaryCurrency(target)
  const secondaryTotal = billing.monthly === null ? null : convertAmount(billing.monthly, target, secondary, state.fx)
  const hasPrice = state.hosts.some(host => host.meta.price !== null)
  const tiles: { label: string; value: string; note: string; tone: Tone; link?: 'cost' | 'renewal' }[] = [
    { label: zh ? '运行正常' : 'Healthy', value: `${healthy}/${overviewHosts.length}`, note: unknown.length ? zh ? `${unknown.length} 台状态待确认` : `${unknown.length} need checking` : t('overview.hosts', { count: overviewHosts.length }), tone: healthy === overviewHosts.length ? 'ok' : 'none' },
    { label: zh ? '需要处理' : 'Needs attention', value: needs || !unknown.length ? String(needs) : '—', note: needs ? zh ? `共 ${pending.length} 项提醒` : `${pending.length} ${pending.length === 1 ? 'notice' : 'notices'}` : unknown.length ? zh ? '状态未确认，不能判断' : 'Status unknown; refresh to assess' : zh ? '已采集状态无已知问题' : 'No known issues in collected status', tone: pending.some((row) => row.issue.level === 'bad') ? 'bad' : needs ? 'warn' : unknown.length ? 'none' : 'ok' },
    { label: zh ? '每月费用' : 'Monthly cost', value: !hasPrice ? t('billing.notEntered') : billing.monthly === null ? '—' : money(billing.monthly, target, state.locale), note: !hasPrice ? '' : secondaryTotal === null ? t('overview.noCost') : money(secondaryTotal, secondary, state.locale), tone: 'none', link: 'cost' },
    { label: zh ? `${REMINDER_WINDOW_DAYS} 天内续费` : `Renewals in ${REMINDER_WINDOW_DAYS} days`, value: hasPrice ? String(summary.expiring.length) : t('billing.notEntered'), link: hasPrice ? undefined : 'renewal', note: !hasPrice ? '' : summary.expiring[0] ? `${summary.expiring[0].name} · ${localDate(effectiveRenewAt(summary.expiring[0].meta, now)!) === localDate(now) ? (zh ? '今天续费' : 'Renews today') : localDate(effectiveRenewAt(summary.expiring[0].meta, now)!)}` : zh ? '近期无需续费' : 'Nothing due soon', tone: hasPrice && summary.expiring.length ? 'warn' : 'none' }
  ]
  const open = (hostId: string, section: HostSection = 'status') => (onOpenHost ?? openHost)(hostId, section)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return <section className="min-w-0 flex-1 overflow-auto p-6" aria-label={t('overview.title')}>
    {keystoreReadFailed && <div data-keystore-notice role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel p-4 text-[13px]">
      <p className="min-w-0 flex-1 leading-6 text-ink">{KEYSTORE_UNREADABLE[state.locale]}</p>
      <QuietButton disabled={relaunching} onClick={() => {
        setRelaunching(true)
        void api().app.relaunch().catch(error => { setRelaunching(false); toast(t(errorText(error)), 'err') })
      }}>{t('credentials.relaunch')}</QuietButton>
    </div>}
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold" data-overview-unknown={unknown.length || undefined}>{updates ? t(updates === 1 ? 'collection.pendingOne' : 'collection.pending', { count: updates }) : title}</h1>
      <QuietButton disabled={!overviewHosts.length || collecting} onClick={() => { for (const host of overviewHosts) void refreshHost(host.id) }}><RefreshCw className={`h-4 w-4 ${collecting ? 'animate-spin' : ''}`} />{t(collecting ? 'overview.collecting' : 'overview.refreshAll')}</QuietButton>
    </header>
    {!state.hosts.length ? <div className="rounded-xl border border-dashed border-line p-10 text-center"><h2 className="text-lg">{t('overview.emptyHosts')}</h2><p className="mx-auto mb-5 mt-2 max-w-md text-sm text-muted">{zh ? '通过 SSH 查看服务器状态、管理文件和执行维护。先添加主机，或导入已有 SSH 配置。' : 'Check servers, manage files and perform maintenance over SSH. Add a host or import your SSH configuration.'}</p><div className="flex justify-center gap-3"><PrimaryButton onClick={() => patch({ hostDialog: 'new' })}><Plus className="h-4 w-4" />{t('onboarding.add')}</PrimaryButton><QuietButton onClick={() => patch({ importSshConfigOpen: true })}>{t('importSsh.title')}</QuietButton></div></div> : <>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">{tiles.map(tile => {
        const content = <><p className="text-xs text-muted">{tile.label}</p><p className="mt-2 break-words font-mono text-xl font-medium leading-snug" style={{ color: tile.tone === 'none' ? undefined : toneColor[tile.tone] }}>{tile.value}</p>{tile.note && <p className="mt-2 text-xs leading-5 text-muted">{tile.note}</p>}</>
        const style = 'relative min-w-0 rounded-xl border border-line bg-panel px-4 py-3 text-left'
        return tile.link ? <button key={tile.label} type="button" data-billing-cost={tile.link === 'cost' || undefined} data-billing-renewal={tile.link === 'renewal' || undefined} onClick={() => hasPrice ? navigate({ page: 'billing' }) : open(state.hosts[0]!.id, 'assets')} className={`${style} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}>{content}</button> : <div key={tile.label} className={style}>{content}</div>
      })}</div>
      {pending.length > 0 && <section className="mb-6"><h2 className="mb-2 text-sm font-semibold">{zh ? '需要处理' : 'Needs attention'} <span className="ml-1 font-mono text-muted">{pending.length}</span></h2><div className="divide-y divide-line rounded-xl border border-line bg-panel">
        {pending.map(({ host, issue }) => <div key={`${host.id}:${issue.key}`} className="flex flex-wrap items-center gap-3 p-3 text-[13px]"><span className="rounded px-2 py-0.5 text-xs" style={{ color: `var(--${issue.level === 'bad' ? 'risk' : 'warn'}-fg)`, background: `var(--${issue.level === 'bad' ? 'risk' : 'warn'}-bg)` }}>{issue.level === 'bad' ? zh ? '风险' : 'Risk' : zh ? '提醒' : 'Notice'}</span><button className="w-32 truncate text-left font-medium hover:text-accent" onClick={() => open(host.id)}>{host.name}</button><div className="min-w-0 flex-1"><span>{issue.title}</span><span className="ml-2 font-mono text-xs text-muted">{issue.detail}</span></div><button className="inline-flex items-center gap-1 text-accent" onClick={() => open(host.id, issue.section)}>{zh ? '查看' : 'Review'}<ArrowRight className="h-3.5 w-3.5" /></button></div>)}
      </div></section>}
      <section><h2 className="mb-2 text-sm font-semibold">{zh ? '所有主机' : 'All hosts'} <span className="ml-1 font-mono text-muted">{state.hosts.length}</span></h2><div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {rows.map(({ host, record, issues }) => <HostCard key={host.id} host={host}
          record={keystoreReadFailed && record && isKeystoreReadError(record.error) ? { ...record, error: t('overview.incomplete') } : record}
          issues={issues} busy={state.collecting.includes(host.id)} now={now} locale={state.locale} intervalMinutes={intervalMinutes}
          onOpen={() => open(host.id)} onRefresh={() => void refreshHost(host.id)} onConnect={() => void connectHost(host, {}, false, record?.needsAttention)} onEdit={() => patch({ hostDialog: host })} />)}
      </div>
        {remainingHosts.length > 0 && <>
          <div className="mt-3 grid gap-3" data-overview-limited style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', maskImage: 'linear-gradient(to bottom, #000, #0004)' }}>
            {remainingHosts.map(host => <button key={host.id} data-overview-limited-host={host.id} onClick={() => open(host.id)} className="min-w-0 rounded-xl border border-line bg-panel p-4 text-left transition-colors hover:border-accent/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              <span className="block truncate text-[14px] font-semibold">{host.name}</span>
              <span className="mt-1 block truncate font-mono text-[11px] text-muted">{host.host}{host.port !== 22 && `:${host.port}`}</span>
            </button>)}
          </div>
          <div className="mt-4 space-y-1 text-[12px] text-muted" data-overview-limit-note>
            <p>{t('overview.limitExplanation', { count: overviewHostLimit })}</p>
          </div>
        </>}
      </section>
    </>}
  </section>
}
