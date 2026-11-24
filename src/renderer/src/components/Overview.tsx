import { useEffect, useState } from 'react'
import { isKeystoreReadError, KEYSTORE_UNREADABLE } from '../../../shared/host-secrets'
import { ArrowRight, ChevronDown, ChevronRight, Plus, RefreshCw } from 'lucide-react'
import { billingSummary } from '../../../core/billing'
import { displayCurrency, secondaryCurrency } from '../../../core/currency'
import { effectiveRenewAt, REMINDER_WINDOW_DAYS } from '../../../core/reminders'
import { convertAmount } from '../../../core/billing'
import { localDate } from '../../../core/reminders'
import { navigate } from '../state/navigation'
import { costSummary } from '../../../core/health'
import { money } from '../logic/overview'
import { useRendererCapabilities } from '../ext/capabilities'
import { collectionNeedsUpdate, collectionUnknown, hostIssues, type HostIssue, type HostSection } from '../logic/host-workspace'
import { HostCard } from './HostCard'
import { toneColor, type Tone } from './Gauge'
import { api, connectHost, errorText, refreshHost, shallowEqual, toast, useAppSelector, patch, openHost } from '../state'
import { PrimaryButton, QuietButton, useT } from './ui'

function issueActionLabel(issue: HostIssue, zh: boolean): string {
  if (issue.section === 'maintenance') return zh ? '去清理' : 'Clean up'
  if (issue.section === 'security') return zh ? '查安全' : 'Security'
  if (issue.section === 'assets') return zh ? '看资产' : 'Assets'
  return zh ? '查看' : 'Review'
}

export function Overview({ onOpenHost }: { onOpenHost?: (hostId: string, section?: HostSection) => void }) {
  const state = useAppSelector((s) => ({ hosts: s.hosts, snapshots: s.snapshots, collecting: s.collecting, locale: s.settings?.language ?? 'zh', settings: s.settings, fx: s.fx }), shallowEqual)
  const [now, setNow] = useState(Date.now)
  const [issuesCollapsed, setIssuesCollapsed] = useState(false)
  const [expandedHosts, setExpandedHosts] = useState<Record<string, boolean>>({})
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
  const issueGroups = rows.filter((row) => row.issues.length > 0).sort((a, b) => Number(b.issues[0]?.level === 'bad') - Number(a.issues[0]?.level === 'bad'))
  const issues = issueGroups.flatMap((row) => row.issues)
  const riskCount = issues.filter((issue) => issue.level === 'bad').length
  const warnCount = issues.length - riskCount
  const unknown = rows.filter((row) => row.unknown)
  const updates = unknown.filter(row => collectionNeedsUpdate(row.record, now, intervalMinutes)).length
  const needs = issueGroups.length
  const healthy = rows.filter((row) => !row.unknown && !row.issues.length).length
  const title = !state.hosts.length ? zh ? '添加第一台主机' : 'Add your first host'
    : needs ? zh ? '需要处理' : 'Needs attention'
    : updates ? t(updates === 1 ? 'collection.pendingOne' : 'collection.pending', { count: updates })
    : unknown.length ? zh ? '待确认' : 'Needs checking'
    : remainingHosts.length ? (zh ? `前 ${overviewHosts.length} 台正常` : `First ${overviewHosts.length} OK`)
    : zh ? '一切正常' : 'All good'
  const target = displayCurrency(state.settings?.displayCurrency, state.locale)
  const billing = billingSummary(state.hosts, target, state.fx, now)
  const secondary = secondaryCurrency(target)
  const secondaryTotal = billing.monthly === null ? null : convertAmount(billing.monthly, target, secondary, state.fx)
  const hasPrice = state.hosts.some(host => host.meta.price !== null)
  const issueSummary = [
    riskCount ? (zh ? `${riskCount} 风险` : `${riskCount} ${riskCount === 1 ? 'risk' : 'risks'}`) : '',
    warnCount ? (zh ? `${warnCount} 提醒` : `${warnCount} ${warnCount === 1 ? 'notice' : 'notices'}`) : ''
  ].filter(Boolean).join(' · ')
  const healthyNote = [
    unknown.length ? (zh ? `${unknown.length} 台待确认` : `${unknown.length} need checking`) : '',
    remainingHosts.length ? (zh ? `另 ${remainingHosts.length} 台未自动采集` : `${remainingHosts.length} not auto-collected`) : ''
  ].filter(Boolean).join(' · ')
  const tiles: { label: string; value: string; note: string; tone: Tone; link?: 'cost' | 'renewal' }[] = [
    { label: zh ? '运行正常' : 'Healthy', value: `${healthy}/${overviewHosts.length}`, note: healthyNote, tone: unknown.length === 0 && remainingHosts.length === 0 && overviewHosts.length > 0 && healthy === overviewHosts.length ? 'ok' : 'none' },
    { label: zh ? '需要处理' : 'Needs attention', value: needs || !unknown.length ? String(needs) : '—', note: needs ? issueSummary : unknown.length ? (zh ? '待确认' : 'Needs checking') : '', tone: riskCount ? 'bad' : needs ? 'warn' : unknown.length ? 'none' : 'ok' },
    { label: zh ? '每月费用' : 'Monthly cost', value: !hasPrice ? t('billing.notEntered') : billing.monthly === null ? '—' : money(billing.monthly, target, state.locale), note: !billing.monthly || secondaryTotal === null ? '' : money(secondaryTotal, secondary, state.locale), tone: 'none', link: 'cost' },
    { label: zh ? `${REMINDER_WINDOW_DAYS} 天内续费` : `Renewals in ${REMINDER_WINDOW_DAYS} days`, value: hasPrice ? String(summary.expiring.length) : t('billing.notEntered'), link: hasPrice ? undefined : 'renewal', note: !hasPrice ? '' : summary.expiring[0] ? `${summary.expiring[0].name} · ${localDate(effectiveRenewAt(summary.expiring[0].meta, now)!) === localDate(now) ? (zh ? '今天续费' : 'Renews today') : localDate(effectiveRenewAt(summary.expiring[0].meta, now)!)}` : '', tone: hasPrice && summary.expiring.length ? 'warn' : 'none' }
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
      <h1 className="text-xl font-semibold" data-overview-unknown={unknown.length || undefined}>{title}</h1>
      <QuietButton disabled={!overviewHosts.length || collecting} onClick={() => { for (const host of overviewHosts) void refreshHost(host.id) }}><RefreshCw className={`h-4 w-4 ${collecting ? 'animate-spin' : ''}`} />{t(collecting ? 'overview.collecting' : 'overview.refreshAll')}</QuietButton>
    </header>
    {!state.hosts.length ? <div className="rounded-xl border border-dashed border-line p-10 text-center"><h2 className="text-lg">{t('overview.emptyHosts')}</h2><p className="mx-auto mb-5 mt-2 max-w-md text-sm text-muted">{zh ? '仅通过 SSH 连接，不在服务器安装任何组件。先添加主机，或导入已有 SSH 配置。' : 'Connect over SSH with nothing installed on your servers. Add a host or import your SSH configuration.'}</p><div className="flex justify-center gap-3"><PrimaryButton onClick={() => patch({ hostDialog: 'new' })}><Plus className="h-4 w-4" />{t('onboarding.add')}</PrimaryButton><QuietButton onClick={() => patch({ importSshConfigOpen: true })}>{t('importSsh.title')}</QuietButton></div></div> : <>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">{tiles.map(tile => {
        const content = <><p className="text-xs text-muted">{tile.label}</p><p className="mt-2 break-words font-mono text-xl font-medium leading-snug" style={{ color: tile.tone === 'none' ? undefined : toneColor[tile.tone] }}>{tile.value}</p>{tile.note && <p className="mt-2 text-xs leading-5 text-muted">{tile.note}</p>}</>
        const style = 'relative flex min-w-0 flex-col items-start justify-start rounded-xl border border-line bg-panel px-4 py-3 text-left'
        return tile.link ? <button key={tile.label} type="button" data-billing-cost={tile.link === 'cost' || undefined} data-billing-renewal={tile.link === 'renewal' || undefined} onClick={() => hasPrice ? navigate({ page: 'billing' }) : open(state.hosts[0]!.id, 'assets')} className={`${style} focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}>{content}</button> : <div key={tile.label} className={style}>{content}</div>
      })}</div>
      {issueGroups.length > 0 && <section className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <button type="button" aria-expanded={!issuesCollapsed} onClick={() => setIssuesCollapsed(!issuesCollapsed)} className="inline-flex items-center gap-1.5 text-sm font-semibold hover:text-accent">
            {issuesCollapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted" /> : <ChevronDown className="h-3.5 w-3.5 text-muted" />}
            <span>{zh ? '需要处理' : 'Needs attention'}</span>
            <span className="ml-1 font-mono text-xs font-normal text-muted">{issueSummary}</span>
          </button>
          <button type="button" aria-expanded={!issuesCollapsed} onClick={() => setIssuesCollapsed(!issuesCollapsed)} className="ml-auto text-xs text-muted hover:text-ink">{issuesCollapsed ? (zh ? '展开' : 'Expand') : (zh ? '收起' : 'Collapse')}</button>
        </div>
        {!issuesCollapsed && <div className="divide-y divide-line rounded-xl border border-line bg-panel">
          {issueGroups.map(({ host, issues }) => {
            const top = issues[0]!
            const rest = issues.slice(1)
            const expanded = Boolean(expandedHosts[host.id])
            return <div key={host.id}>
              <div className="flex flex-wrap items-center gap-3 p-3 text-[13px]">
                <span className="rounded px-2 py-0.5 text-xs" style={{ color: `var(--${top.level === 'bad' ? 'risk' : 'warn'}-fg)`, background: `var(--${top.level === 'bad' ? 'risk' : 'warn'}-bg)` }}>{top.level === 'bad' ? zh ? '风险' : 'Risk' : zh ? '提醒' : 'Notice'}</span>
                <button type="button" className="w-32 truncate text-left font-medium hover:text-accent" onClick={() => open(host.id)}>{host.name}</button>
                <div className="min-w-0 flex-1"><span>{top.title}</span><span className="ml-2 font-mono text-xs text-muted">{top.detail}</span></div>
                {rest.length > 0 && <button type="button" aria-expanded={expanded} className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-ink" onClick={() => setExpandedHosts(current => ({ ...current, [host.id]: !current[host.id] }))}>{expanded ? (zh ? '收起' : 'Hide') : zh ? `+${rest.length} 项` : `+${rest.length}`}</button>}
                <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => open(host.id, top.section)}>{issueActionLabel(top, zh)}<ArrowRight className="h-3.5 w-3.5" /></button>
              </div>
              {expanded && rest.length > 0 && <div className="divide-y divide-line border-t border-line bg-canvas/60">
                {rest.map((issue) => <div key={`${host.id}:${issue.key}`} className="flex flex-wrap items-center gap-3 py-2.5 pl-10 pr-3 text-[12px]">
                  <span className="rounded px-1.5 py-0.5 text-[11px]" style={{ color: `var(--${issue.level === 'bad' ? 'risk' : 'warn'}-fg)`, background: `var(--${issue.level === 'bad' ? 'risk' : 'warn'}-bg)` }}>{issue.level === 'bad' ? zh ? '风险' : 'Risk' : zh ? '提醒' : 'Notice'}</span>
                  <div className="min-w-0 flex-1"><span>{issue.title}</span><span className="ml-2 font-mono text-xs text-muted">{issue.detail}</span></div>
                  <button type="button" className="inline-flex items-center gap-1 text-xs text-accent hover:underline" onClick={() => open(host.id, issue.section)}>{issueActionLabel(issue, zh)}<ArrowRight className="h-3 w-3" /></button>
                </div>)}
              </div>}
            </div>
          })}
        </div>}
      </section>}
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
