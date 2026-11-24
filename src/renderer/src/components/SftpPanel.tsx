import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, FolderPlus, RefreshCw, Upload } from 'lucide-react'
import type { SftpEntry, TransferJob } from '@shared/types'
import { api, errorText, patch, toast, useAppSelector } from '../state'
import { requestTextInput, useT } from './ui'
import { useShellIntegration } from '../logic/shell-integration'
import { loadTransferSnapshot } from '../state/transfers'
import { transferErrorText } from '../logic/transfer-error'

export const SftpPanel = memo(function SftpPanel({ sessionId, fullWidth = false, integrationSessionId }: { sessionId: string; fullWidth?: boolean; integrationSessionId?: string }) {
  const t = useT()
  const jobs = useAppSelector((state) => state.transfers[sessionId]) ?? []
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [editingPath, setEditingPath] = useState(false)
  const integration = useShellIntegration(integrationSessionId ?? sessionId)
  const [follow, setFollow] = useState(() => localStorage.getItem('hopline-sftp-follow') !== 'false')
  const request = useRef(0)

  const load = async (dir?: string) => {
    const ticket = ++request.current
    setLoading(true)
    setError('')
    setEntries([])
    setSelected(null)
    try {
      const result = await api().sftp.list(sessionId, dir)
      if (ticket !== request.current) return
      setCwd(result.path)
      setEntries(result.entries)
      setSelected(null)
    } catch (err) {
      if (ticket !== request.current) return
      setError(errorText(err))
    } finally {
      if (ticket === request.current) setLoading(false)
    }
  }

  useEffect(() => {
    setCwd('')
    setEditingPath(false)
    void load(follow && integration.active ? integration.cwd : undefined)
    const stopTransfers = loadTransferSnapshot(sessionId, (error) => toast(transferErrorText(error), 'err'))
    return () => { stopTransfers(); request.current++; closeEntryMenu() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (follow && integration.active && integration.cwd) void load(integration.cwd)
  }, [sessionId, follow, integration.active, integration.cwd])

  const uploadPaths = async (paths: string[]) => {
    if (!paths.length || !cwd || loading || error) return
    try {
      await api().sftp.upload(sessionId, paths, cwd)
    } catch (err) {
      toast(transferErrorText(err), 'err')
    }
  }

  return (
    <section
      data-ready={loading ? 'loading' : 'sftp'}
      className={`relative flex min-h-0 flex-col border-line bg-panel ${fullWidth ? 'w-full flex-1' : 'w-[400px] shrink-0 border-l'}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDrag(false)
        const paths = [...event.dataTransfer.files].map((file) => api().getPathForFile(file)).filter(Boolean)
        void uploadPaths(paths)
      }}
    >
      <header className="flex items-center gap-1 px-3 pt-3">
        <div className="text-[12px] font-medium tracking-wide text-muted">{t('sftp.title')}</div>
        <div className="ml-auto flex items-center">
          <Tiny label={t('sftp.parent')} onClick={() => cwd && cwd !== '/' && void load(parentOf(cwd))}>↑</Tiny>
          <Tiny label={t('sftp.refresh')} onClick={() => void load(cwd)}><RefreshCw className="h-3.5 w-3.5" /></Tiny>
          <Tiny disabled={loading || !!error || !cwd} label={t('sftp.mkdir')} onClick={() => makeDir(sessionId, cwd, t, () => load(cwd))}><FolderPlus className="h-3.5 w-3.5" /></Tiny>
          <Tiny
            label={t('sftp.upload')}
            disabled={loading || !!error || !cwd}
            onClick={() =>
              void api()
                .dialog.pick('files')
                .then((paths) => uploadPaths(paths))
                .catch((error) => toast(transferErrorText(error), 'err'))
            }
          >
            <Upload className="h-3.5 w-3.5" />
          </Tiny>
          <Tiny disabled={!selected || loading || !!error} label={t('sftp.download')} onClick={() => void downloadSelected(sessionId, entries.find((entry) => entry.path === selected) ?? null)}>
            <Download className="h-3.5 w-3.5" />
          </Tiny>
        </div>
      </header>
      {integration.active && <label className="mx-3 mt-2 flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={follow} onChange={(event) => { setFollow(event.target.checked); localStorage.setItem('hopline-sftp-follow', String(event.target.checked)) }} />{t('shellIntegration.follow')}</label>}
      {editingPath ? (
        <input
          autoFocus
          defaultValue={cwd}
          className="mx-3 mt-2 h-8 px-2 font-mono text-[12px]"
          onBlur={() => setEditingPath(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void load((event.target as HTMLInputElement).value)
              setEditingPath(false)
            }
            if (event.key === 'Escape') setEditingPath(false)
          }}
        />
      ) : (
        <button type="button" onClick={() => setEditingPath(true)} className="mx-3 mt-2 truncate rounded-lg px-2 py-1 text-left font-mono text-[12px] text-muted hover:bg-black/5 dark:hover:bg-white/6">
          {cwd || '…'}
        </button>
      )}
      <div className="scroll-thin mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && <p className="px-2 py-6 text-[12px] text-muted">{t('sftp.loading')}</p>}
        {error && <p className="px-2 py-4 text-[12px] text-red-600">{t(error)}</p>}
        {!loading && !error && entries.length === 0 && <p className="px-2 py-6 text-[12px] text-muted">{t('sftp.empty')}</p>}
        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => setSelected(entry.path)}
            onDoubleClick={() => {
              if (entry.isDirectory) void load(entry.path)
              else requestEdit(sessionId, entry.path, t)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              setSelected(entry.path)
              openEntryMenu(event.clientX, event.clientY, entry, sessionId, () => load(cwd), (dir) => void load(dir), t)
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${selected === entry.path ? 'bg-accent-soft' : 'hover:bg-black/5 dark:hover:bg-white/6'}`}
          >
            <span className={`w-4 text-center text-[12px] ${entry.isDirectory ? 'text-accent' : 'text-muted'}`}>{entry.isDirectory ? '▸' : '·'}</span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
            <span className="shrink-0 text-[11px] text-muted">{entry.isDirectory ? '' : formatBytes(entry.size)}</span>
          </button>
        ))}
      </div>
      {jobs.length > 0 && (
        <div className="max-h-40 overflow-y-auto border-t border-line px-3 py-2">
          <div className="mb-1 text-[11px] text-muted">{t('sftp.queue')}</div>
          {jobs.slice(-6).map((job) => (
            <JobRow key={job.id} job={job} cancelLabel={t('sftp.cancel')} />
          ))}
        </div>
      )}
      {drag && (
        <div className="absolute inset-2 grid place-items-center rounded-2xl border border-dashed border-accent bg-accent-soft text-[13px] text-accent">
          {t('sftp.drop')}
        </div>
      )}
    </section>
  )
})

function JobRow({ job, cancelLabel }: { job: TransferJob; cancelLabel: string }) {
  const t = useT()
  const ratio = job.total > 0 ? Math.min(100, Math.round((job.loaded / job.total) * 100)) : job.status === 'done' ? 100 : 0
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="min-w-0 flex-1 truncate">{job.name}</span>
        <span className="text-muted">{job.status === 'error' ? t(errorText(job.error ?? '')) : `${ratio}%`}</span>
        {(job.status === 'queued' || job.status === 'running') && (
          <button type="button" className="text-muted hover:text-ink" onClick={() => void api().sftp.cancel(job.id).catch((error) => toast(transferErrorText(error), 'err'))}>
            {cancelLabel}
          </button>
        )}
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
        <div className="h-full bg-accent" style={{ width: `${ratio}%` }} />
      </div>
    </div>
  )
}

function Tiny({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} title={label} aria-label={label} onClick={onClick} className="disabled:opacity-40 grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/8">
      {children}
    </button>
  )
}

function parentOf(dir: string): string {
  const index = dir.lastIndexOf('/')
  if (index <= 0) return '/'
  return dir.slice(0, index) || '/'
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB']
  let value = size / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function validEntryName(name: string): boolean {
  return name !== '.' && name !== '..' && !/[\/\0\r\n]/.test(name)
}

function makeDir(sessionId: string, cwd: string, t: (key: string) => string, reload: () => void) {
  if (!cwd) return
  requestTextInput({
    title: t('sftp.mkdir'), label: t('sftp.name'),
    validate: (name) => validEntryName(name) ? null : t('sftp.invalidName'),
    submit: async (name) => {
      const dir = cwd === '/' ? `/${name}` : `${cwd.replace(/\/+$/, '')}/${name}`
      await api().sftp.mkdir(sessionId, dir)
      reload()
    }
  })
}

async function downloadSelected(sessionId: string, entry: SftpEntry | null) {
  if (!entry) return
  try {
    const picked = await api().dialog.pick('directory')
    const dir = picked[0]
    if (!dir) return
    await api().sftp.download(sessionId, entry.path, dir)
  } catch (error) {
    toast(transferErrorText(error), 'err')
  }
}

export function requestEdit(sessionId: string, remotePath: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  patch({ confirm: {
    title: t('sftp.editConfirmTitle'), body: t('sftp.editConfirmBody', { path: remotePath }),
    details: { label: t('sftp.editConfirmDetailsLabel'), body: t('sftp.editConfirmDetails') },
    confirm: t('sftp.editConfirmAction'), danger: true,
    run: async () => {
      await api().sftp.edit(sessionId, remotePath).catch(error => { throw new Error(transferErrorText(error)) })
      toast(`${t('toast.edit')} · ${t('sftp.editHint')}`)
    }
  } })
}

let closeEntryMenu = () => {}

function openEntryMenu(
  x: number,
  y: number,
  entry: SftpEntry,
  sessionId: string,
  reload: () => void,
  openDirectory: (dir: string) => void,
  t: (key: string, vars?: Record<string, string | number>) => string
) {
  closeEntryMenu()
  const menu = document.createElement('div')
  menu.id = 'sftp-menu'
  menu.className = 'pop fixed z-50 min-w-36 rounded-xl border border-line bg-panel p-1 text-[13px] shadow-[var(--shadow)]'
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  const items: { label: string; run: () => void; danger?: boolean }[] = [
    {
      label: entry.isDirectory ? entry.name : t('sftp.edit'),
      run: () => (entry.isDirectory ? openDirectory(entry.path) : requestEdit(sessionId, entry.path, t))
    },
    { label: t('sftp.download'), run: () => void downloadSelected(sessionId, entry) },
    {
      label: t('sftp.rename'),
      run: () => requestTextInput({
        title: t('sftp.rename'), initialValue: entry.name,
        validate: (name) => validEntryName(name) ? null : t('sftp.invalidName'),
        submit: async (name) => {
          if (name === entry.name) return
          const parent = parentOf(entry.path)
          await api().sftp.rename(sessionId, entry.path, `${parent === '/' ? '' : parent}/${name}`)
          reload()
        }
      })
    },
    {
      label: t('sftp.delete'),
      danger: true,
      run: () =>
        patch({
          confirm: {
            title: t('sftp.delete'),
            body: t('sftp.deleteBody', { name: entry.name }),
            confirm: t('sftp.delete'),
            danger: true,
            run: async () => {
              await api().sftp.remove(sessionId, entry.path).catch(error => { throw new Error(transferErrorText(error)) })
              reload()
            }
          }
        })
    }
  ]
  for (const item of items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = item.label
    button.className = `block w-full rounded-lg px-2 py-1.5 text-left hover:bg-accent-soft ${item.danger ? 'text-red-600' : ''}`
    button.onclick = () => {
      closeEntryMenu()
      item.run()
    }
    menu.appendChild(button)
  }
  document.body.appendChild(menu)
  const bounds = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - bounds.width))}px`
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - bounds.height))}px`
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeEntryMenu() }
  const onMouseDown = (event: MouseEvent) => { if (!menu.contains(event.target as Node)) closeEntryMenu() }
  window.addEventListener('mousedown', onMouseDown)
  window.addEventListener('keydown', onKey)
  closeEntryMenu = () => {
    menu.remove()
    window.removeEventListener('mousedown', onMouseDown)
    window.removeEventListener('keydown', onKey)
    closeEntryMenu = () => {}
  }
}
