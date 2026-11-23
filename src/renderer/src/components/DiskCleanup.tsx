import { PasswordInput } from './PasswordInput'
import { useEffect, useRef, useState } from 'react'
import type { CleanupDiagnostics } from '../../../core/cleanup/diagnostics'
import { CleanupDiagnosticCards } from './CleanupDiagnosticCards'
import type { CleanupChange } from '../../../core/runbook/cleanup'
import type { CleanupDuResult, HostDisk, RunbookPreview, RunbookProgress } from '@shared/types'
import type { RunbookSummary, StepResult, SudoMode } from '../../../core/runbook/types'
import { api, patch, toast, useAppSelector } from '../state'
import { cleanupDirectories, cleanupReleased, cleanupSelectable, cleanupSelection, cleanupSize } from '../logic/cleanup'
import { runbookError } from '../logic/runbook'
import { snapshotIsStale } from '../../../core/snapshot-freshness'
import { CleanupConfirmation, CleanupReady, CleanupReadyFooter, CleanupResults } from './CleanupViews'
import { Meter, toneColor } from './Gauge'
import { Field, Modal, PrimaryButton, QuietButton, TextInput, useT } from './ui'

export function DiskCleanup() {
  const hostId = useAppSelector((state) => state.cleanupHost)
  return hostId ? <CleanupPanel key={hostId} hostId={hostId} /> : null
}
function CleanupPanel({ hostId }: { hostId: string }) {
  const t = useT(), host = useAppSelector((state) => state.hosts.find((item) => item.id === hostId))
  const record = useAppSelector((state) => state.snapshots[hostId])
  const snapshot = record?.snapshot
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const interval = useAppSelector(s => s.settings?.collectionIntervalMinutes)
  const historicalDisk = !!record?.error || snapshotIsStale(record, now, interval)
  const hidden = useAppSelector((state) => state.cleanupHidden ?? false)
  const [tab, setTab] = useState<'clean' | 'analysis'>('clean')
  const notified = useRef(false), notificationAction = useRef<(() => Promise<void>) | undefined>(undefined)
  const clearNotice = () => {
    const action = notificationAction.current
    if (action) patch(current => ({ ...current, toasts: current.toasts.filter(item => item.action?.run !== action) }))
  }
  useEffect(() => () => clearNotice(), [])
  const [latestDisk, setLatestDisk] = useState<HostDisk>()
  const disks = snapshot?.disk.status === 'unavailable' ? [] : [...snapshot?.disk.data ?? []].map(disk => latestDisk?.mountpoint === disk.mountpoint ? latestDisk : disk).sort((a, b) => b.usagePercent - a.usagePercent)
  const [diagnostics, setDiagnostics] = useState<CleanupDiagnostics>()
  const [mount, setMount] = useState(''), [du, setDu] = useState<CleanupDuResult>()
  const [plan, setPlan] = useState<RunbookPreview>(), [selected, setSelected] = useState<string[]>([])
  const [sudo, setSudo] = useState<SudoMode>(), [busy, setBusy] = useState('permission'), [error, setError] = useState(''), [password, setPassword] = useState('')
  // Never put the workflow credential in the global store, previews, persisted state or results.
  const credential = useRef(''), alive = useRef(true), activeRead = useRef<string | undefined>(undefined), readCanceled = useRef(false)
  const [confirmed, setConfirmed] = useState(false), [consumed, setConsumed] = useState(false), [stopping, setStopping] = useState(false)
  const [results, setResults] = useState<Record<string, StepResult>>({}), [changes, setChanges] = useState<Record<string, CleanupChange>>({})
  const [summary, setSummary] = useState<RunbookSummary>()
  const [comparison, setComparison] = useState<{ mount: string; before: HostDisk | null; after: HostDisk | null }>()
  const mountpoint = disks.some((disk) => disk.mountpoint === mount) ? mount : disks[0]?.mountpoint ?? ''
  useEffect(() => {
    if (mount !== mountpoint) { setMount(mountpoint); setDu(undefined) }
  }, [mount, mountpoint])
  const directories = cleanupDirectories(du?.output ?? '')
  const failed = (err: unknown) => {
    const reason = runbookError(err)
    if (reason === 'runbook.targetChanged') {
      // Keep already-received item results, but never reuse the old target's
      // credential, preview, permission result or disk comparison.
      credential.current = ''; setPassword(''); setSudo(undefined); setPlan(undefined)
      setConfirmed(false); setDiagnostics(undefined); setDu(undefined); setComparison(undefined); setLatestDisk(undefined)
    }
    setError(reason)
  }
  const probePermission = async () => {
    credential.current = ''; setPassword(''); setSudo(undefined)
    setBusy('permission'); setError(''); setStopping(false); readCanceled.current = false
    const requestId = crypto.randomUUID(); activeRead.current = requestId
    try {
      const mode = await api().cleanup.sudo(hostId, requestId)
      if (!alive.current || activeRead.current !== requestId || readCanceled.current) throw new Error('cleanup.readOnlyCanceled')
      setSudo(mode)
    } catch (err) {
      if (alive.current && activeRead.current === requestId) failed(err)
    } finally {
      // An earlier effect's completion must not clear a newer request's state.
      if (activeRead.current === requestId) {
        activeRead.current = undefined
        if (alive.current) { setBusy(''); setStopping(false) }
      }
    }
  }
  useEffect(() => {
    alive.current = true
    void probePermission()
    return () => {
      alive.current = false; credential.current = ''
      const requestId = activeRead.current; activeRead.current = undefined
      if (requestId) void api().runbook.cancel(hostId, requestId).catch(() => {})
    }
  }, [hostId])
  useEffect(() => api().on('runbook:progress', (event: RunbookProgress) => {
    if (event.hostId !== hostId || event.planId !== plan?.id) return
    setResults((current) => ({ ...current, [event.result.stepId]: event.result }))
    if (event.cleanup) setChanges((current) => ({ ...current, [event.result.stepId]: event.cleanup! }))
  }), [hostId, plan?.id])
  const work = async (kind: string, action: () => Promise<void>) => {
    setBusy(kind); setError('')
    try { await action() } catch (err) { if (alive.current) failed(err) } finally { if (alive.current) { setBusy(''); setStopping(false) } }
  }
  const check = () => !sudo ? probePermission() : work('check', async () => {
    if (sudo === 'missing') return
    setDiagnostics(undefined); setPlan(undefined); setResults({}); setChanges({}); setSummary(undefined); setComparison(undefined); setConfirmed(false); setConsumed(false); setSelected([])
    if (password) credential.current = password
    setPassword(''); setStopping(false); readCanceled.current = false
    const requestId = crypto.randomUUID(); activeRead.current = requestId
    let preview: RunbookPreview | undefined
    try {
      preview = await api().runbook.plan(hostId, 'cleanup', {}, credential.current, requestId)
      if (!alive.current || readCanceled.current) throw new Error('cleanup.readOnlyCanceled')
      const diagnosed = await api().cleanup.diagnose(hostId, credential.current, requestId)
      if (!alive.current || readCanceled.current) throw new Error('cleanup.readOnlyCanceled')
      setSudo(preview.sudo); setPlan(preview); setSelected(cleanupSelection(preview).filter(id => cleanupSelectable(preview!).includes(id))); setDiagnostics(diagnosed)
    } catch (err) {
      credential.current = ''
      if (preview) void api().runbook.cancel(hostId, preview.id).catch(() => {})
      throw err
    } finally { activeRead.current = undefined }
  })
  const run = () => work('before', async () => {
    if (!plan || consumed || !confirmed) return
    setConsumed(true); setStopping(false); setPassword('')
    // Measure this mount once on either side; item measurements stay separate.
    let before: HostDisk | null = null
    try { before = await api().cleanup.disk(hostId, mountpoint) }
    catch (err) { if (runbookError(err) === 'runbook.targetChanged') throw err /* Never execute a stale authorization. */ }
    try {
      setBusy('run')
      setSummary(await api().runbook.run(hostId, plan.id, selected, credential.current || undefined))
    } finally {
      credential.current = ''
      if (alive.current) setBusy('after')
      let after: HostDisk | null = null
      try { after = await api().cleanup.disk(hostId, mountpoint) }
      catch (err) { if (runbookError(err) === 'runbook.targetChanged') throw err /* Keep item results without comparing different targets. */ }
      if (alive.current) { setComparison({ mount: mountpoint, before, after }); if (after) setLatestDisk(after) }
    }
  })
  const close = () => {
    if (busy) { patch({ cleanupHidden: true }); return }
    credential.current = ''; setPassword(''); clearNotice()
    if (plan) void api().runbook.cancel(hostId, plan.id).catch(() => {})
    patch({ cleanupHost: null, cleanupHidden: false })
  }
  // Hiding the view keeps this same workflow mounted; credentials never leave its ref.
  useEffect(() => {
    if (consumed && !busy && (hidden || tab === 'analysis') && !notified.current) {
      notified.current = true
      notificationAction.current = async () => { clearNotice(); patch({ cleanupHidden: false }); setTab('clean') }
      toast(t(error === 'runbook.targetChanged' ? error : Object.values(changes).some(change => change.before !== null && change.after !== null) ? 'cleanup.ui.notification' : 'cleanup.ui.notificationUnknown', { host: host?.name ?? '', size: Object.values(changes).some(change => change.before !== null && change.after !== null) ? cleanupSize(cleanupReleased(changes)) : t('cleanup.ui.unmeasured') }), error === 'runbook.targetChanged' ? 'err' : 'ok', { duration: 0, action: { label: t('cleanup.ui.viewResults'), run: notificationAction.current } })
    }
    if (!consumed) notified.current = false
    if (!hidden && tab === 'clean') clearNotice()
  }, [consumed, busy, hidden, tab, error])
  useEffect(() => {
    if ((sudo === 'root' || sudo === 'nopass') && !busy && !plan && !error) void check()
  }, [sudo, busy, plan, error])
  const select = (ids: string[]) => { setSelected(ids); setConfirmed(false) }
  const rescan = () => {
    setTab('clean'); setError(''); clearNotice()
    if (!sudo || sudo === 'password' && !credential.current) {
      setPlan(undefined); setSummary(undefined); setComparison(undefined); setResults({}); setChanges({}); setConsumed(false); setConfirmed(false); setSelected([])
      if (!sudo) void probePermission()
    } else void check()
  }
  const cancelRead = () => {
    readCanceled.current = true; setStopping(true)
    if (activeRead.current) void api().runbook.cancel(hostId, activeRead.current).catch((err) => setError(runbookError(err)))
  }
  const stop = () => {
    setStopping(true); void api().runbook.cancel(hostId, plan?.id).catch((err) => { setStopping(false); setError(runbookError(err)) })
  }
  const analyze = () => void work('du', async () => {
    setDu(undefined); setStopping(false); readCanceled.current = false
    const requestId = crypto.randomUUID(); activeRead.current = requestId
    try { const result = await api().cleanup.du(hostId, mountpoint, requestId); if (alive.current && !readCanceled.current) setDu(result) }
    finally { activeRead.current = undefined }
  })
  const disk = latestDisk?.mountpoint === mountpoint ? latestDisk : historicalDisk ? undefined : disks.find(item => item.mountpoint === mountpoint)
  const mountSelector = disks.length > 1 ? <select data-cleanup-mount aria-label={t('cleanup.ui.mount')} className="max-w-40 px-2 py-1 font-mono text-[12px]" disabled={!!busy} value={mountpoint} onChange={event => { setMount(event.target.value); setDu(undefined) }}>{disks.map(item => <option key={item.mountpoint} value={item.mountpoint}>{item.mountpoint}</option>)}</select> : null
  const showAnalysis = (section?: string) => { setTab('analysis'); if (section) requestAnimationFrame(() => document.querySelector(`[data-cleanup-diagnostic="${section}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })) }
  const findings = diagnostics?.deleted.status === 'available' && diagnostics.deleted.data.totalBytes >= 100 * 1024 * 1024 ? 'deleted' : diagnostics?.inodes.status === 'available' && diagnostics.inodes.data.some(item => item.mountpoint === mountpoint && item.usagePercent > 95) ? 'inodes' : undefined
  const running = ['before', 'run', 'after'].includes(busy)
  const scanning = ['permission', 'check'].includes(busy)
  const done = !busy && (!!summary || consumed)
  const ready = !!plan && !consumed && !busy
  const completed = selected.filter(id => results[id]).length
  const current = plan?.steps.find(step => selected.includes(step.id) && !results[step.id])?.id
  const footer = tab === 'clean' && ready ? <CleanupReadyFooter plan={plan!} selected={selected} onSelect={select} onConfirm={() => setConfirmed(true)} /> : tab === 'clean' && done ? <div data-cleanup-footer className="flex justify-end gap-2"><QuietButton onClick={rescan}>{t('cleanup.ui.rescan')}</QuietButton><PrimaryButton onClick={close}>{t('cleanup.ui.done')}</PrimaryButton></div> : undefined
  return <>
    <Modal open={!hidden} title={`${t('cleanup.title')} · ${host?.name ?? t('overview.missing')}`} placement="drawer" wideDrawer onClose={close} footer={footer}>
      <div data-cleanup-panel className="min-w-0 text-[13px]">
        <div role="tablist" aria-label={t('cleanup.title')} className="sticky top-0 z-10 flex gap-6 border-b border-line bg-panel">
          {(['clean', 'analysis'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} aria-controls={`cleanup-${value}`} className={`border-b-2 py-3 text-[13px] ${tab === value ? 'border-accent text-ink' : 'border-transparent text-muted'}`} onClick={() => setTab(value)}>{t(value === 'clean' ? 'cleanup.clean' : 'cleanup.ui.analysis')}</button>)}
        </div>
        {tab === 'clean' ? <div id="cleanup-clean" role="tabpanel">
          {ready && historicalDisk && !disk && <p data-cleanup-historical className="pt-4 text-[12px] text-muted">{t('cleanup.historyDisk')}</p>}
          {ready ? <CleanupReady plan={plan!} selected={selected} onSelect={select} disk={disk} mountSelector={mountSelector} notice={findings && <p className="flex items-center gap-2 text-[12px]" style={{ color: toneColor.warn }}><span>{t(`cleanup.ui.notice.${findings}`)}</span><button className="shrink-0 underline underline-offset-2" onClick={() => showAnalysis(findings)}>{t('cleanup.ui.view')}</button></p>} /> : done ? <CleanupResults selected={selected} results={results} changes={changes} comparison={comparison} /> : <div className="flex min-h-[430px] flex-col items-center justify-center gap-5 px-8 text-center" data-cleanup-stage={running ? 'running' : scanning ? 'scanning' : 'password'}>
            {running ? <>
              <h3 className="text-[20px] font-medium">{t(busy === 'after' ? 'cleanup.ui.measuring' : 'cleanup.ui.cleaning', { name: current ? t(`cleanup.ui.name.${current}`) : t('cleanup.ui.measuring') })}</h3>
              <p className="font-mono text-[12px] text-muted">{t('cleanup.ui.progress', { current: Math.min(completed + 1, selected.length), total: selected.length })}</p>
              <div className="w-full max-w-xs" role="progressbar" aria-label={t('cleanup.clean')} aria-valuemin={0} aria-valuemax={selected.length} aria-valuenow={completed}><Meter value={selected.length ? completed / selected.length * 100 : 0} tone="none" /></div>
              <QuietButton disabled={stopping || busy !== 'run'} onClick={stop}>{t(stopping ? 'cleanup.ui.stopping' : 'cleanup.ui.stop')}</QuietButton>
            </> : scanning ? <>
              <p className="text-[16px]">{t(stopping ? 'cleanup.readStopping' : 'cleanup.ui.scanning')}</p><div role="progressbar" aria-label={t('cleanup.ui.scanning')} className="h-1 w-56 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}><div className="h-full w-1/3 animate-pulse rounded-full bg-accent" /></div><QuietButton disabled={stopping} onClick={cancelRead}>{t('cleanup.ui.cancel')}</QuietButton>
            </> : <>
              <h3 className="text-[20px] font-medium">{t(sudo === 'password' ? 'cleanup.ui.password' : 'cleanup.title')}</h3>
              {sudo === 'password' && <div className="w-full max-w-xs space-y-5 text-left"><p className="text-[12px] text-muted">{t('cleanup.ui.passwordNote')}</p><Field label={t('cleanup.ui.passwordLabel')}><PasswordInput secretLabel={t('cleanup.ui.passwordLabel')} autoComplete="off" autoFocus value={password} onChange={event => setPassword(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && password && !busy) void check() }} /></Field></div>}
              {sudo === 'missing' ? <p className="text-muted">{t('cleanup.rootRequired')}</p> : <PrimaryButton disabled={!host || sudo === 'password' && !password && !credential.current || !!busy} onClick={() => void check()}>{t('cleanup.ui.scan')}</PrimaryButton>}
            </>}
          </div>}
        </div> : <div id="cleanup-analysis" role="tabpanel" className="space-y-6 pt-5" data-cleanup-analysis>
          <div className="flex items-center justify-between gap-3"><h3 className="text-[15px] font-medium">{t('cleanup.ui.directories')}</h3><div className="flex items-center gap-2">{mountSelector}<QuietButton disabled={!!busy || !mountpoint || !host} onClick={analyze}>{t('cleanup.ui.analyze')}</QuietButton></div></div>
          <p className="text-[12px] text-muted">{t('cleanup.directoryNote')}</p>
          {busy === 'du' && <div className="flex items-center justify-between"><p role="status">{t('cleanup.ui.analyzing')}</p><QuietButton disabled={stopping} onClick={cancelRead}>{t('cleanup.ui.cancel')}</QuietButton></div>}
          {directories.length > 0 && <ol data-cleanup-directories className="space-y-4">{directories.map((directory, index) => <li key={`${directory.path}:${index}`} className="space-y-1.5"><div className="flex justify-between gap-3 font-mono text-[12px]"><span className="min-w-0 break-all">{directory.path}</span><span className="shrink-0">{cleanupSize(directory.bytes)}</span></div><Meter value={directory.bytes > 0 ? directory.bytes / directories[0].bytes * 100 : null} tone="none" className="h-1" /></li>)}</ol>}
          {du && !directories.length && <p className="text-muted">{t('cleanup.noDirectoryData')}</p>}
          {du && (du.timedOut || du.truncated || du.incomplete) && <p role="status" style={{ color: toneColor.warn }}>{t(du.timedOut ? 'cleanup.timeout' : 'cleanup.partial')}</p>}
          {diagnostics ? <CleanupDiagnosticCards diagnostics={diagnostics} /> : <p className="text-[12px] text-muted">{t('cleanup.ui.analysisAfterScan')}</p>}
        </div>}
        {error && <p role="alert" className="mt-4 text-[12px]" style={{ color: toneColor.bad }}>{t(error)}</p>}
      </div>
    </Modal>
    {confirmed && ready && !hidden && <CleanupConfirmation plan={plan!} selected={selected} onClose={() => setConfirmed(false)} onRun={() => void run()} />}
  </>
}
