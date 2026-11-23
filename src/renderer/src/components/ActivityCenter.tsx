import { localDateTime } from '../../../core/reminders'
import { useEffect, useState } from 'react'
import type { OpLogEntry } from '@shared/types'
import { api, errorText, openHost, shallowEqual, toast, toggleForward, useAppSelector } from '../state'
import { forwardLabel } from '../logic/palette'
import { loadTransferSnapshot } from '../state/transfers'
import { transferErrorText } from '../logic/transfer-error'
import { QuietButton, useT } from './ui'

export function ActivityCenter() {
  const { hosts, tabs, transfers, forwards } = useAppSelector(s => ({ hosts: s.hosts, tabs: s.tabs, transfers: s.transfers, forwards: s.forwards }), shallowEqual)
  const en = useAppSelector(s => s.settings?.language === 'en'), t = useT()
  const [section, setSection] = useState<'transfers' | 'forwards' | 'history'>('transfers')
  const [hostId, setHostId] = useState('')
  const [history, setHistory] = useState<(OpLogEntry & { hostId: string })[]>([])
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => loadTransferSnapshot(undefined, (error) => setError(errorText(error))), [])
  useEffect(() => {
    if (section !== 'history') return
    let active = true
    setLoading(true); setError('')
    void Promise.allSettled(hosts.filter(host => !hostId || host.id === hostId).map(async host => (await api().oplog.list(host.id)).map(row => ({ ...row, hostId: host.id })))).then(results => {
      if (!active) return
      setHistory(results.flatMap(result => result.status === 'fulfilled' ? result.value : []).sort((a, b) => b.at - a.at))
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') setError(errorText(failed.reason))
      setLoading(false)
    })
    const off = api().on('runbook:progress', () => setRevision(value => value + 1))
    return () => { active = false; off() }
  }, [hosts, hostId, section, revision])
  const owner = (id?: string) => hosts.find(host => host.id === id)?.name ?? (en ? 'Deleted host' : '已删除主机')
  const jobs = Object.values(transfers).flat().filter(job => !hostId || (job.hostId ?? tabs.find(tab => tab.id === job.sessionId)?.hostId) === hostId)
  const rules = hosts.filter(host => !hostId || host.id === hostId).flatMap(host => host.forwards.map(rule => ({ host, rule, status: forwards.find(status => status.hostId === host.id && status.ruleId === rule.id) })))
  return <section className="workspace-page" aria-label={en ? 'Activity' : '活动'}>
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-semibold">{en ? 'Activity' : '活动'}</h1><p className="mt-2 text-[13px] text-muted">{en ? 'File transfers, tunnels and maintenance records across your hosts.' : '统一查看文件传输、端口转发与维护记录。'}</p></div>
      <select aria-label={en ? 'Filter by host' : '按主机筛选'} className="max-w-64 p-2 text-[12px]" value={hostId} onChange={event => setHostId(event.target.value)}><option value="">{en ? 'All hosts' : '全部主机'}</option>{hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}</select>
    </header>
    <nav className="my-5 flex gap-1 border-b border-line" aria-label={en ? 'Activity category' : '活动分类'}>{(['transfers', 'forwards', 'history'] as const).map((value, index) => <button type="button" key={value} aria-current={section === value ? 'page' : undefined} className={`border-b-2 px-4 py-3 text-[13px] ${section === value ? 'border-accent text-accent' : 'border-transparent text-muted'}`} onClick={() => { setSection(value); setError('') }}>{(en ? ['Transfers', 'Port forwarding', 'Maintenance history'] : ['文件传输', '端口转发', '维护记录'])[index]}</button>)}</nav>
    {error && <p role="alert" className="mb-4 break-words text-sm text-red-600 dark:text-red-300">{t(error)}</p>}
    {section === 'transfers' && <div className="space-y-2">{!jobs.length && <Empty text={en ? 'No file transfers yet. Open a host’s Files tab to upload or download.' : '暂无传输。从主机的「文件」页上传或下载后，会在这里显示进度。'} />}{jobs.map(job => <article key={job.id} className="rounded-lg border border-line p-4 text-[13px]">
      <div className="flex items-center justify-between gap-3"><strong className="min-w-0 truncate">{job.direction === 'upload' ? '↑' : '↓'} {job.name}</strong><span>{(en ? { queued: 'Queued', running: 'Transferring', done: 'Completed', error: 'Failed', cancelled: 'Cancelled' } : { queued: '排队中', running: '传输中', done: '已完成', error: '失败', cancelled: '已取消' })[job.status]}</span></div>
      <p className="my-2 break-all text-[12px] text-muted">{owner(job.hostId ?? tabs.find(tab => tab.id === job.sessionId)?.hostId)} · {job.remotePath}</p>
      <div className="flex items-center gap-3"><progress aria-label={job.name} className="h-1.5 flex-1 accent-accent" max={Math.max(job.total, 1)} value={job.status === 'done' ? Math.max(job.total, 1) : job.loaded} /><span className="font-mono text-[11px]">{bytes(job.loaded)} / {bytes(job.total)}</span>{['queued', 'running'].includes(job.status) && <QuietButton onClick={() => void api().sftp.cancel(job.id).catch(err => toast(transferErrorText(err), 'err'))}>{en ? 'Cancel' : '取消'}</QuietButton>}</div>
      {job.error && <p className="mt-2 break-words text-red-600 dark:text-red-300">{t(errorText(job.error))}</p>}
    </article>)}</div>}
    {section === 'forwards' && <div className="space-y-2">{!rules.length && <Empty text={t('forward.empty')} />}{rules.map(({ host, rule, status }) => <article key={`${host.id}:${rule.id}`} className="rounded-lg border border-line p-4 text-[13px]"><div className="flex flex-wrap items-center justify-between gap-3"><button className="text-accent" onClick={() => openHost(host.id, 'maintenance')}>{host.name}</button><span className="break-all font-mono text-[12px]">{forwardLabel(rule)}</span><QuietButton onClick={() => void toggleForward(host.id, rule.id, status?.state === 'running')}>{t(status?.state === 'running' ? 'forward.stop' : 'forward.start')}</QuietButton></div><p className="mt-2 text-muted">{t(`forward.${status?.state ?? 'stopped'}`)} · {t('forward.connections', { count: status?.connections ?? 0 })}</p>{status?.error && <p className="break-words text-red-600 dark:text-red-300">{status.error}</p>}</article>)}</div>}
    {section === 'history' && <div className="space-y-2"><QuietButton onClick={() => setRevision(value => value + 1)}>{en ? 'Refresh records' : '刷新记录'}</QuietButton>{loading && <p role="status" className="text-sm text-muted">{t('runbook.loading')}</p>}{!loading && !history.length && <Empty text={en ? 'No maintenance records yet.' : '暂无维护记录。'} />}{history.map((row, index) => <article key={`${row.hostId}:${row.at}:${index}`} className="rounded-lg border border-line p-4 text-[13px]"><div className="flex flex-wrap gap-3"><button className="text-accent" onClick={() => openHost(row.hostId, 'maintenance')}>{owner(row.hostId)}</button><strong>{t(row.title)}</strong><span>{t(`runbook.${row.status}`)}</span><time className="ml-auto text-[12px] text-muted">{localDateTime(row.at)}</time></div><p className="mt-2 text-muted">{row.reason.split('；').map(part => t(part)).join(' · ')}</p>{row.output && <details className="mt-2"><summary>{t('runbook.output')}</summary><pre className="mt-2 select-text whitespace-pre-wrap break-all font-mono text-[12px]">{row.output}</pre></details>}</article>)}</div>}
  </section>
}
function Empty({ text }: { text: string }) { return <p className="rounded-lg border border-dashed border-line px-5 py-12 text-center text-[13px] text-muted">{text}</p> }
function bytes(value: number) { return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB` }
