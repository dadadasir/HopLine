import { sshCommand } from '../../../core/connection-info'
import { REMINDER_WINDOW_DAYS } from '../../../core/reminders'
import { useEffect, useState, type ReactNode } from 'react'
import { Copy, FolderOpen, KeyRound, Pencil, Terminal } from 'lucide-react'
import type { HostSnapshot, Locale } from '@shared/types'
import { installShellIntegration, uninstallShellIntegration } from '../../../core/runbook/shell-integration'
import { timezoneRunbook } from '../../../core/runbook/samples'
import { formatCell, sectionNote, updatedAgo } from '../logic/overview'
import { hostIssues, snapshotIsStale, snapshotSections, type HostSection } from '../logic/host-workspace'
import { api, connectHost, errorText, openHost, patch, shallowEqual, toast, toggleForward, useAppSelector } from '../state'
import { openCleanup, openInit, openOpLog, openRunbook } from '../state/runbook'
import { forwardLabel } from '../logic/palette'
import { AssetForm } from './AssetDialog'
import { SecurityPanel } from './SecurityDialog'
import { HostStatus } from './HostStatus'
import { IconButton, PrimaryButton, QuietButton, useT } from './ui'
export type { HostSection } from '../logic/host-workspace'

export function HostWorkspace({ hostId, section, onSectionChange, renderFiles }: { hostId: string; section: HostSection; onSectionChange?: (section: HostSection) => void; renderFiles?: ReactNode }) {
  const state = useAppSelector((s) => ({ host: s.hosts.find((h) => h.id === hostId), record: s.snapshots[hostId], busy: s.collecting.includes(hostId), locale: s.settings?.language ?? 'zh', intervalMinutes: s.settings?.collectionIntervalMinutes, forwards: s.forwards }), shallowEqual)
  const [now, setNow] = useState(Date.now)
  const [visited, setVisited] = useState<Set<HostSection>>(() => new Set([section]))
  const shown = (value: HostSection) => section === value || visited.has(value)
  const changeSection = onSectionChange ?? ((value: HostSection) => openHost(hostId, value))
  useEffect(() => { setVisited((current) => current.has(section) ? current : new Set([...current, section])) }, [section])
  const t = useT(), zh = state.locale === 'zh'
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const host = state.host
  if (!host) return <div className="p-6 text-sm text-muted">{t('overview.missing')}</div>
  const labels: Record<HostSection, string> = { status: zh ? '状态' : 'Status', security: zh ? '安全' : 'Security', maintenance: zh ? '维护' : 'Maintenance', files: zh ? '文件' : 'Files', assets: zh ? '资产' : 'Assets' }
  const issues = hostIssues(host, state.record, now, state.locale, state.intervalMinutes)
  const command = sshCommand(host)
  const stale = snapshotIsStale(state.record, now, state.intervalMinutes)
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={host.name}>
    <header className="shrink-0 px-6 pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{host.name}</h1>
          <button type="button" title={t('credentials.copySsh')} data-ssh-command
            className="group mt-1 flex items-center gap-2 break-all rounded text-left font-mono text-xs text-muted hover:text-accent"
            onClick={() => void api().clipboard.write(command).then(() => toast(t('toast.copied'))).catch(error => toast(t(errorText(error)), 'err'))}>
            {command}<Copy aria-hidden="true" className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>
          {stale && <p data-snapshot-stale className="mt-1 text-xs text-muted">{updatedAgo(state.record?.updatedAt ?? null, now, state.locale)}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <IconButton label={t('credentials.copyConnectionCard')} onClick={() =>
            void api().hosts.copyConnectionCard(host.id).then(() => toast(t('credentials.connectionCardCopied'))).catch(error => toast(t(errorText(error)), 'err'))}>
            <KeyRound className="h-4 w-4" />
          </IconButton>
          <QuietButton onClick={() => patch({ hostDialog: host })}><Pencil className="h-3.5 w-3.5" />{zh ? '编辑连接' : 'Edit connection'}</QuietButton>
          <PrimaryButton onClick={() => void connectHost(host)}><Terminal className="h-4 w-4" />{zh ? '打开终端' : 'Open terminal'}</PrimaryButton>
        </div>
      </div>
      {state.record?.needsAttention ? <div data-collection-attention role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-lg px-3 text-[13px]" style={{ color: 'var(--warn-fg)', background: 'var(--warn-bg)' }}>
        <strong>{t('collection.attention')}</strong>
        <QuietButton onClick={() => void connectHost(host, {}, false, true)}>{t('collection.confirm')}</QuietButton>
      </div> : state.record?.error && <div role="status" className="mt-3 break-words rounded-lg px-3 py-2 text-[13px]" style={{ color: 'var(--risk-fg)', background: 'var(--risk-bg)' }}>
        <strong>{t('collection.failed')}</strong><p className="mt-1">{t(state.record.error)}</p>
      </div>}
      <nav className="mt-5 flex gap-1 border-b border-line" aria-label={zh ? '主机功能' : 'Host sections'}>{Object.entries(labels).map(([id, label]) => <button key={id} aria-current={section === id ? 'page' : undefined} onClick={() => changeSection(id as HostSection)} className={`border-b-2 px-4 pb-3 pt-2 text-[13px] ${section === id ? 'border-accent font-medium text-accent' : 'border-transparent text-muted hover:text-ink'}`}>{label}</button>)}</nav>
    </header>
    {shown('files') && <div style={{ display: section === 'files' ? undefined : 'none' }} className="flex min-h-0 flex-1 flex-col">{renderFiles ?? <div className="p-6 text-sm text-muted"><FolderOpen className="mb-3 h-7 w-7" />{zh ? '文件访问正在准备，请重新打开文件页。' : 'File access is preparing. Reopen the Files tab.'}</div>}</div>}
    <div style={{ display: section === 'files' ? 'none' : undefined }} className="flex min-h-0 flex-1 flex-col">
      {shown('status') && <div style={{ display: section === 'status' ? undefined : 'none' }} className="min-h-0 flex-1 overflow-auto p-6">
        <HostStatus host={host} record={state.record} issues={issues} busy={state.busy} now={now} locale={state.locale} intervalMinutes={state.intervalMinutes} onIssue={(issue) => {
          if (issue.section !== 'status') return changeSection(issue.section)
          const target = document.getElementById(`${hostId}-section-${issue.key === 'swap' ? 'memory' : issue.key}`)
          if (target instanceof HTMLDetailsElement) target.open = true
          target?.scrollIntoView({ block: 'start' })
        }} />
      </div>}
      {shown('security') && <div style={{ display: section === 'security' ? undefined : 'none' }} className="min-h-0 flex-1 overflow-auto p-6"><SecurityPanel key={hostId} hostId={hostId} /></div>}
      {shown('assets') && <div style={{ display: section === 'assets' ? undefined : 'none' }} className="min-h-0 max-w-2xl flex-1 overflow-auto p-6"><h2 className="mb-2 text-base font-semibold">{zh ? '资产信息' : 'Asset details'}</h2><p className="mb-5 text-sm text-muted">{zh ? `记录厂商、费用和续费日期。续费前 ${REMINDER_WINDOW_DAYS} 天会在总览提醒；不会读取云厂商账号。` : `Track the provider, cost and renewal date. Renewals appear in Overview ${REMINDER_WINDOW_DAYS} days ahead; no cloud account is accessed.`}</p><AssetForm key={hostId} host={host} onSaved={() => toast(zh ? '资产信息已保存' : 'Asset details saved')} /></div>}
      {shown('maintenance') && <div style={{ display: section === 'maintenance' ? undefined : 'none' }} className="min-h-0 max-w-3xl flex-1 space-y-6 overflow-auto p-6"><div><h2 className="text-base font-semibold">{labels.maintenance}</h2><p className="mt-1 text-sm text-muted">{zh ? '按需执行维护。远端改动前可查看计划与命令。' : 'Run maintenance when needed. Review the plan and commands before remote changes.'}</p></div><div className="divide-y divide-line rounded-lg border border-line bg-panel">{[
        { label: t('init.title'), description: zh ? '配置用户、公钥、防火墙和更新，敏感步骤包含登录验证。' : 'Configure users, keys, firewall and updates with login verification for sensitive changes.', action: () => openInit(hostId) },
        { label: t('cleanup.title'), description: zh ? '先分析可清理内容，再预览并执行所选步骤。' : 'Analyze reclaimable space, then preview and run selected steps.', action: () => openCleanup(hostId) },
        { label: t(timezoneRunbook.title), description: zh ? '检查当前时区并预览修改。' : 'Check the timezone and preview changes.', action: () => openRunbook(timezoneRunbook, hostId) },
        { label: t(installShellIntegration.title), description: zh ? '让终端识别当前目录和命令结束状态。' : 'Let the terminal detect the current directory and command completion.', action: () => openRunbook(installShellIntegration, hostId) },
        { label: t(uninstallShellIntegration.title), description: zh ? '预览并移除 HopLine 的 Shell 集成。' : 'Preview and remove HopLine shell integration.', action: () => openRunbook(uninstallShellIntegration, hostId) }
      ].map((item) => <div key={item.label} className="flex items-center justify-between gap-4 p-4"><div><h3 className="text-sm font-medium">{item.label}</h3><p className="mt-1 text-xs text-muted">{item.description}</p></div><QuietButton onClick={item.action}>{zh ? '打开' : 'Open'}</QuietButton></div>)}</div>
        <section><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{t('forward.view')}</h2><QuietButton onClick={() => patch({ hostDialog: host })}>{zh ? '配置规则' : 'Configure rules'}</QuietButton></div>{!host.forwards.length && <p className="text-sm text-muted">{t('forward.empty')}</p>}{host.forwards.map((rule) => { const status = state.forwards.find((s) => s.hostId === hostId && s.ruleId === rule.id); return <div key={rule.id} className="mb-2 rounded-lg border border-line p-3 text-[13px]"><div className="flex items-center justify-between gap-3"><span className="break-all">{forwardLabel(rule)}</span><QuietButton onClick={() => void toggleForward(hostId, rule.id, status?.state === 'running')}>{t(status?.state === 'running' ? 'forward.stop' : 'forward.start')}</QuietButton></div><p className="mt-1 text-xs text-muted">{t(`forward.${status?.state ?? 'stopped'}`)} · {t('forward.connections', { count: status?.connections ?? 0 })}</p>{status?.error && <p className="mt-1 break-words text-red-700 dark:text-red-300">{status.error}</p>}</div> })}</section>
        <QuietButton onClick={() => openOpLog(hostId)}>{t('runbook.log')}</QuietButton>
      </div>}
    </div>
  </section>
}

export function SnapshotDetails({ snapshot, locale, prefix = 'host' }: { snapshot: HostSnapshot; locale: Locale; prefix?: string }) {
  const t = useT()
  return <div className="space-y-5">{snapshotSections(snapshot).map(({ key, section, rows, columns }) => <section id={`${prefix}-section-${key}`} key={key} className="scroll-mt-4"><h2 className="mb-2 text-sm font-semibold">{t(`overview.${key}`)}</h2>{sectionNote(section, locale) && <p className="mb-2 text-xs text-muted">{sectionNote(section, locale)}</p>}{rows.length > 0 ? <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full text-left text-xs"><thead><tr>{columns.map((column) => <th key={column} className="border-b border-line p-2.5 font-normal text-muted">{t(`overview.field.${column}`)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column} className="border-b border-line p-2.5 align-top">{formatCell(column, row[column], locale)}</td>)}</tr>)}</tbody></table></div> : <p className="text-xs text-muted">{section.status === 'unavailable' ? '—' : t('overview.empty')}</p>}</section>)}</div>
}
