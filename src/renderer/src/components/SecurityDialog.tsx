import { PasswordInput } from './PasswordInput'
import { localDateTime } from '../../../core/reminders'
import { useEffect, useRef, useState } from 'react'
import type { SecurityReport, SecurityResult } from '@shared/types'
import { api, errorText, patch, toast, useAppSelector } from '../state'
import { Modal, PrimaryButton, QuietButton, TextInput, useT } from './ui'
import { Check, CircleHelp, Copy, EyeOff, ShieldAlert, TriangleAlert } from 'lucide-react'
import { commandsText, evidenceText, securityRows } from '../logic/security'
import { Ring, scoreTone, toneColor } from './Gauge'
import { ShareCard } from './ShareCard'

export function SecurityDialogs() {
  const id = useAppSelector((s) => s.securityHost)
  return id ? <SecurityDialog key={id} hostId={id} /> : null
}
function SecurityDialog({ hostId }: { hostId: string }) {
  const t = useT(), host = useAppSelector((s) => s.hosts.find((h) => h.id === hostId))
  return <Modal open title={`${t('security.title')}: ${host?.name ?? t('overview.missing')}`} onClose={() => patch({ securityHost: null })} width="w-[760px]"><SecurityPanel hostId={hostId} /></Modal>
}

export function SecurityPanel({ hostId }: { hostId: string }) {
  const t = useT(), host = useAppSelector((s) => s.hosts.find((h) => h.id === hostId)), zh = useAppSelector((s) => s.settings?.language !== 'en')
  const pageVisible = useAppSelector(s => s.route.page === 'host' && s.route.hostId === hostId && s.route.section === 'security')
  const dialogVisible = useAppSelector(s => s.securityHost === hostId)
  const [report, setReport] = useState<SecurityReport | null>(null), [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [error, setError] = useState('')
  const revision = useRef(0), busy = loading || working
  const [sudo, setSudo] = useState(false), [password, setPassword] = useState(''), [share, setShare] = useState(false), [shareHost, setShareHost] = useState(false)
  // Host views stay mounted across navigation. Re-read persisted results when
  // returning, including checks completed from the first-use tour or a dialog.
  useEffect(() => {
    if (!pageVisible && !dialogVisible) return
    let active = true
    const expected = revision.current
    setLoading(true); setError('')
    void api().security.latest(hostId).then(r => { if (active && revision.current === expected) setReport(r) }).catch(e => { if (active && revision.current === expected) setError(errorText(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [hostId, pageVisible, dialogVisible])
  const run = async (task: () => Promise<SecurityReport | null>) => {
    revision.current++; setWorking(true); setError('')
    try { const r = await task(); if (r) setReport(r) } catch (e) { setError(errorText(e)) }
    finally { revision.current++; setWorking(false) }
  }
  const check = () => { const value = sudo ? password : undefined; setPassword(''); setShare(false); void run(() => api().security.check(hostId, { sudoPassword: value })) }
  const rows = (status: SecurityResult['status'] | 'hints') => securityRows(report?.results ?? [], status)
  const failed = rows('fail'), unknownCount = rows('unknown').length, ignoredCount = rows('ignored').length, passedCount = rows('pass').length
  const levels = (['high', 'medium', 'low'] as const).map((level) => ({ level, count: failed.filter((r) => r.severity === level).length }))
  const ignored = ignoredCount ? (zh ? ` · 已忽略 ${ignoredCount} 项` : ` · ${ignoredCount} ignored`) : ''
  const reportHeading = failed.length
    ? (zh ? `发现 ${failed.length} 个问题` : `${failed.length} ${failed.length === 1 ? 'issue' : 'issues'} found`)
    : !passedCount
      ? (unknownCount ? (zh ? '无法确认' : 'Could not verify') : (zh ? '无通过结果' : 'No passing results')) + ignored
      : unknownCount ? (zh ? '已检项通过' : 'Checked items passed') + ignored
      : ignoredCount ? (zh ? '通过' : 'Passed') + ignored
      : (zh ? '全部通过' : 'All passed')
  return <div className="space-y-5 text-[13px]">
      {report && <section className="grid-dots flex flex-wrap items-center gap-6 rounded-xl border border-line bg-panel p-5">
        <Ring value={report.score} tone={scoreTone(report.score)} size={104} stroke={9} label={`${zh ? '安全评分' : 'Security score'} ${report.score}/100`}><span><span className="font-mono text-[26px] font-medium leading-none" style={{ color: toneColor[scoreTone(report.score)] }}>{report.score}</span><span className="block font-mono text-[10px] text-muted">/100</span></span></Ring>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{zh ? '安全评分' : 'Security score'}</p>
          <h2 className="mt-1 text-lg font-semibold">{reportHeading}</h2>
          <div className="mt-3 flex flex-wrap gap-2">{levels.map(({ level, count }) => <span key={level} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs" style={count ? { color: `var(--${level === 'high' ? 'risk' : level === 'medium' ? 'warn' : 'unknown'}-fg)`, background: `var(--${level === 'high' ? 'risk' : level === 'medium' ? 'warn' : 'unknown'}-bg)` } : { color: 'var(--muted)', border: '1px solid var(--line)' }}>{t(`security.${level}`)}<span className="font-mono">{count}</span></span>)}</div>
          <p className="mt-3 font-mono text-[11px] text-muted">{localDateTime(report.snapshot.collectedAt)}</p>
        </div>
      </section>}
      {!report && <div className="rounded-lg border border-line bg-canvas p-4"><h2 className="font-medium">{zh ? '未检查' : 'Not checked'}</h2><p className="mt-1 text-muted">{zh ? '只读检查 SSH、防火墙、更新与证书，不改动服务器。' : 'Read-only check of SSH, firewall, updates, and certificates. Changes nothing on the server.'}</p></div>}
      <div className="flex flex-wrap gap-2"><PrimaryButton disabled={busy || !host} onClick={() => { setSudo(false); setPassword(''); void run(() => api().security.check(hostId)) }}>{t(busy ? 'runbook.checking' : report ? 'security.recheck' : 'security.startCheck')}</PrimaryButton><QuietButton disabled={busy || !host} onClick={() => setSudo(true)}>{t(report ? 'security.sudo' : 'security.startSudo')}</QuietButton>{report && <QuietButton disabled={busy} onClick={() => setShare(!share)}>{t('security.share')}</QuietButton>}</div>
      {sudo && <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); check() }}><PasswordInput secretLabel={t('runbook.password')} autoComplete="off" aria-label={t('runbook.password')} placeholder={t('runbook.password')} value={password} onChange={(e) => setPassword(e.target.value)} /><PrimaryButton type="submit" disabled={busy}>{t('runbook.check')}</PrimaryButton></form>}
      {error && <p role="alert" className="text-red-600">{t(error)}</p>}
      {report && share && <section className="space-y-3 rounded-xl border border-line p-4"><div className="overflow-hidden rounded-lg border border-line"><ShareCard report={report} host={shareHost ? host?.host : undefined} /></div><div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={shareHost} onChange={(e) => setShareHost(e.target.checked)} />{t('security.shareHost')}</label><PrimaryButton disabled={busy} onClick={() => void run(async () => { await api().security.share(hostId, { host: shareHost }); return null })}>{t('security.saveShare')}</PrimaryButton></div></section>}
      {report && (['fail', 'hints', 'unknown', 'pass', 'ignored'] as const).map((status) => rows(status).length === 0 && status !== 'fail' ? null : <details key={status} open={status === 'fail' || status === 'unknown'} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-sm font-semibold"><span className="text-muted transition-transform group-open:rotate-90">›</span>{t(`security.${status}`)}<span className="font-mono font-normal text-muted">{rows(status).length}</span></summary>
        {status === 'unknown' && rows(status).length > 0 && <p className="mt-1 text-xs text-muted">{t('security.more')}</p>}
        {status === 'fail' && rows(status).length === 0 && <p className="mt-2 text-muted">{zh ? '未发现已知问题' : 'No known issues'}</p>}
        <div className={status === 'pass' ? 'mt-2 divide-y divide-line rounded-xl border border-line' : 'mt-2 space-y-2.5'}>{rows(status).map((r) => <SecurityRow key={`${r.id}:${r.status}`} result={r} compact={status === 'pass'} note={report?.ignores[r.id]?.note} busy={busy} onIgnore={(note) => void run(() => note === null ? api().security.unignore(hostId, r.id) : api().security.ignore(hostId, r.id, note))} onCopy={(text) => void run(async () => { await api().clipboard.write(text); toast(zh ? '命令已复制' : 'Commands copied'); return null })} />)}</div>
      </details>)}
      {report && <p className="text-xs leading-5 text-muted">{t('security.runbook')}</p>}
    </div>
}
function SecurityRow({ result: r, note, busy, compact, onIgnore, onCopy }: { result: SecurityResult; note?: string; busy: boolean; compact?: boolean; onIgnore: (note: string | null) => void; onCopy: (text: string) => void }) {
  const t = useT(), [editing, setEditing] = useState(false), [value, setValue] = useState('')
  const locale = useAppSelector((s) => s.settings?.language ?? 'zh'), commands = commandsText(r.fix?.commands ?? '', locale)
  const hint = r.id === 'ssh-default-port', failing = r.status === 'fail' && !hint
  const kind = failing ? r.severity === 'high' ? 'risk' : r.severity === 'medium' ? 'warn' : 'unknown' : 'unknown'
  const Icon = r.status === 'pass' ? Check : r.status === 'ignored' ? EyeOff : r.status === 'unknown' || hint ? CircleHelp : r.severity === 'high' ? ShieldAlert : TriangleAlert
  if (compact) return <div className="flex items-start gap-3 px-3 py-2.5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--ok-fg)' }} /><div className="min-w-0"><p>{t(r.title).replace(/（不扣分）| \(no score deduction\)/, '')}</p><p className="mt-0.5 break-words text-xs text-muted">{evidenceText(r, locale)}</p></div></div>
  return <article className="rounded-xl border border-line bg-panel p-4" style={failing ? { borderLeft: `3px solid var(--${kind}-fg)` } : undefined}>
    <header className="flex items-start gap-3"><Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: failing ? `var(--${kind}-fg)` : 'var(--muted)' }} />
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{t(r.title)}</strong><span className="rounded px-1.5 py-0.5 text-[11px]" style={{ color: `var(--${kind}-fg)`, background: `var(--${kind}-bg)` }}>{t(hint ? 'security.hints' : `security.${r.severity}`)}</span></div>
        <p className="mt-1 break-words text-muted">{evidenceText(r, locale)}</p></div>
      {r.status === 'ignored' ? <button className="shrink-0 text-xs text-accent" disabled={busy} onClick={() => onIgnore(null)}>{t('security.restore')}</button> : <button className="shrink-0 text-xs text-muted hover:text-ink" disabled={busy} title={t('security.ignore')} onClick={() => setEditing(!editing)}>{locale === 'zh' ? '忽略' : 'Ignore'}</button>}
    </header>
    {r.status === 'ignored' && note && <p className="ml-7 mt-2 text-xs text-muted">{note}</p>}
    {r.fix && <div className="ml-7 mt-3 border-t border-line pt-3"><p className="eyebrow">{t('security.fix')}</p><p className="mt-1.5 leading-6">{t(r.fix.explain)}</p>
      {r.fix.commands && <div className="relative mt-2.5"><pre className="select-text overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-term p-3 pr-24 font-mono text-xs leading-5">{commands.split('\n').map((line, index) => <span key={index} className={line.startsWith('# ') ? 'block text-muted' : 'block'}>{line.startsWith('# ') ? line : <><span className="select-none text-accent">$ </span>{line}</>}</span>)}</pre><button disabled={busy} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-xs hover:text-accent" onClick={() => onCopy(commands)}><Copy className="h-3 w-3" />{t('security.copy')}</button></div>}</div>}
    {editing && <form className="ml-7 mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); onIgnore(value) }}><TextInput aria-label={t('security.note')} placeholder={t('security.note')} maxLength={500} value={value} onChange={(e) => setValue(e.target.value)} /><PrimaryButton disabled={busy} type="submit">{t('security.ignore')}</PrimaryButton></form>}
  </article>
}
