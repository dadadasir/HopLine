import { PasswordInput } from './PasswordInput'
import { taskNotificationsEnabled, setTaskNotificationsEnabled } from '../state/tabs'
import { useEffect, useRef, useState } from 'react'
import type { CollectionIntervalMinutes, Locale, ThemePreference } from '@shared/types'
import { api, patch, restoreLayoutEnabled, setRestoreLayoutEnabled, toast, useAppSelector } from '../state'
import { Field, Modal, PrimaryButton, QuietButton, TextInput, useT } from './ui'
import { SnippetSettings } from './SnippetForm'
import { useRendererCapabilities } from '../ext/capabilities'
import { ExtensionSettingsPage, ExtensionSettingsTabs } from '../ext/mounts'
import { UpdateSettings } from './UpdateDialog'
import { runbookError } from '../logic/runbook'

type SettingsPageId = 'appearance' | 'transfer' | 'backup' | 'snippets' | `pro:${string}`
export function SettingsDialog() {
  const page = useAppSelector(state => state.settingsOpen), t = useT()
  if (!page) return null
  return <Modal open title={t('settings.title')} onClose={() => patch({ settingsOpen: false })} width="w-[720px]"><SettingsContent page={page} onSelect={page => patch({ settingsOpen: page })} /></Modal>
}
export function SettingsPage() {
  const [page, setPage] = useState<SettingsPageId>('appearance'), t = useT()
  return <section className="workspace-page"><h1 className="mb-6 text-xl font-semibold">{t('settings.title')}</h1><SettingsContent page={page} onSelect={setPage} /></section>
}
function SettingsContent({ page, onSelect }: { page: SettingsPageId; onSelect: (page: SettingsPageId) => void }) {
  const t = useT()
  const [visited, setVisited] = useState<SettingsPageId[]>(() => [page])
  useEffect(() => { setVisited(current => current.includes(page) ? current : [...current, page]) }, [page])
  const pages = visited.includes(page) ? visited : [...visited, page]
  return <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-5">
    <nav className="space-y-1">{(['appearance', 'transfer', 'backup', 'snippets'] as const).map(item => <button key={item} type="button" onClick={() => onSelect(item)} className={`block w-full rounded-md px-2 py-2 text-left text-[13px] ${page === item ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-black/5 dark:hover:bg-white/6'}`}>{t(`settings.${item}`)}</button>)}<ExtensionSettingsTabs page={page} onSelect={onSelect} /></nav>
    <div className="min-h-[360px] min-w-0">{pages.map(id => <div key={id} style={{ display: page === id ? undefined : 'none' }}>{id === 'appearance' && <Appearance />}{id === 'transfer' && <Transfers />}{id === 'backup' && <Backup />}{id === 'snippets' && <SnippetSettings />}{id.startsWith('pro:') && <ExtensionSettingsPage page={id} />}</div>)}</div>
  </div>
}

function Appearance() {
  const settings = useAppSelector((state) => state.settings)
  const { overviewHostLimit } = useRendererCapabilities()
  const [notifications, setNotifications] = useState(taskNotificationsEnabled)
  const [restore, setRestore] = useState(restoreLayoutEnabled)
  const t = useT()
  if (!settings) return null
  return (
    <div className="space-y-5">
      <Choice
        label={t('settings.language')}
        value={settings.language}
        options={[
          ['zh', '中文'],
          ['en', 'English']
        ]}
        onChange={(language) => void update({ language: language as Locale })}
      />
      <div data-display-currency><Choice label={t('settings.displayCurrency')} value={settings.displayCurrency} options={[
        ['auto', t('settings.currencyAuto')], ['CNY', t('settings.currencyCny')], ['USD', t('settings.currencyUsd')]
      ]} onChange={displayCurrency => void update({ displayCurrency })} /></div>
      <Choice
        label={t('settings.theme')}
        value={settings.theme}
        options={[
          ['system', t('settings.system')],
          ['light', t('settings.light')],
          ['dark', t('settings.dark')]
        ]}
        onChange={(theme) => void update({ theme: theme as ThemePreference })}
      />
      <Field label={`${t('settings.font')} · ${settings.fontSize}`}>
        <input
          type="range"
          min={12}
          max={20}
          value={settings.fontSize}
          onChange={(event) => void update({ fontSize: Number(event.target.value) })}
          className="w-full"
        />
      </Field>
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={notifications} onChange={(event) => {
        setNotifications(event.target.checked); setTaskNotificationsEnabled(event.target.checked)
      }} />{t('persistent.notifications')}</label>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={restore} onChange={(event) => {
          setRestore(event.target.checked)
          setRestoreLayoutEnabled(event.target.checked)
        }} />
        {t('settings.restoreLayout')}
      </label>
      <div data-testid="background-setting">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={settings.backgroundStay} onChange={event => void update({ backgroundStay: event.target.checked })} />
          {settings.language === 'en' ? 'Keep running in the menu bar / tray after closing the window' : '关闭窗口后常驻菜单栏／托盘'}
        </label>
        <p className="mt-2 text-[12px] leading-5 text-muted">{settings.language === 'en' ? 'Tray shows cached status only; does not collect data or send reminders. Quit from the tray menu to exit.' : '托盘仅展示已有状态，不后台采集或发提醒；完全退出请在托盘菜单点「退出」。'}</p>
      </div>
      <UpdateSettings />
      <section className="space-y-3 border-t border-line pt-4" data-collection-settings aria-label={t('collection.settings')}>
        <h2 className="text-sm font-semibold">{t('collection.settings')}</h2>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={settings.autoCollect} onChange={event => void update({ autoCollect: event.target.checked })} />
          {t('collection.automatic')}
        </label>
        <Choice label={t('collection.interval')} value={String(settings.collectionIntervalMinutes)}
          options={[1, 5, 15].map(minutes => [String(minutes), t('collection.minutes', { minutes })])}
          onChange={minutes => void update({ collectionIntervalMinutes: Number(minutes) as CollectionIntervalMinutes })} />
        {Number.isFinite(overviewHostLimit) && <p className="text-xs text-muted">{t('overview.limitExplanation', { count: overviewHostLimit })}</p>}
      </section>
    </div>
  )
}

function Transfers() {
  const settings = useAppSelector((state) => state.settings)
  const t = useT()
  if (!settings) return null
  return (
    <div className="space-y-5">
      <Field label={`${t('settings.concurrency')} · ${settings.transferConcurrency}`}>
        <input
          type="range"
          min={1}
          max={6}
          value={settings.transferConcurrency}
          onChange={(event) => void update({ transferConcurrency: Number(event.target.value) })}
          className="w-full"
        />
      </Field>
      <label className="flex items-start gap-3 text-[13px]">
        <input type="checkbox" checked={settings.packSmallFiles} onChange={(event) => void update({ packSmallFiles: event.target.checked })} />
        <span>
          <span className="block">{t('settings.pack')}</span>
          <span className="mt-1 block text-[12px] leading-5 text-muted">{t('settings.packHint')}</span>
        </span>
      </label>
    </div>
  )
}

function Backup() {
  const t = useT()
  const backup = useAppSelector((state) => state.backup)
  const settings = useAppSelector((state) => state.settings)
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmNext, setConfirmNext] = useState('')
  const [changing, setChanging] = useState(false)
  const [remember, setRemember] = useState(backup?.rememberUnlock ?? true)
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [locals, setLocals] = useState<{ name: string; filePath: string; mtimeMs: number }[]>([])
  const [url, setUrl] = useState(settings?.backup.webdav?.url ?? '')
  const [user, setUser] = useState(settings?.backup.webdav?.username ?? '')
  const [pass, setPass] = useState('')
  const [dir, setDir] = useState(settings?.backup.webdav?.remoteDir ?? 'hopline')
  const [error, setError] = useState('')
  const [webdavBusy, setWebdavBusy] = useState<'push' | 'pull' | null>(null)
  const [canceling, setCanceling] = useState(false)
  const webdavRequest = useRef<string | null>(null)
  useEffect(() => () => {
    const requestId = webdavRequest.current
    webdavRequest.current = null
    if (requestId) void api().backup.cancelWebdav(requestId).catch(() => undefined)
  }, [])

  useEffect(() => {
    void api().backup.list().then(setLocals).catch(() => undefined)
  }, [backup?.lastAutoBackupAt, backup?.unlocked])

  const run = async (task: () => Promise<void>) => {
    setError('')
    try {
      await task()
    } catch (err) {
      setError(t(runbookError(err)))
    }
  }

  const syncWebdav = async (direction: 'push' | 'pull') => {
    if (webdavRequest.current) return
    const requestId = crypto.randomUUID()
    webdavRequest.current = requestId
    setWebdavBusy(direction); setCanceling(false); setError('')
    try {
      await api().backup.webdav(direction, password || null, mode, requestId)
      if (webdavRequest.current === requestId) toast(t(direction === 'push' ? 'toast.backup' : 'toast.import'))
    } catch (err) {
      if (webdavRequest.current === requestId) setError(t(runbookError(err)))
    } finally {
      if (webdavRequest.current === requestId) { webdavRequest.current = null; setWebdavBusy(null); setCanceling(false) }
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-5 text-muted">{t('backup.intro')}</p>
      <label className="flex items-center gap-2 text-[13px]"><input data-verify-secrets type="checkbox" checked={settings?.verifySecrets ?? true} onChange={event => void update({ verifySecrets: event.target.checked }).catch(error => toast(t(runbookError(error)), 'err'))} />{t('credentials.verifySetting')}</label>

      <details data-backup-scope className="rounded-lg border border-line p-3 text-[12px] leading-5 text-muted">
        <summary className="cursor-pointer font-medium text-ink">
          {t('backup.scopeTitle')}
          <span className="ml-2 font-normal text-muted">{t('backup.scopeSummary')}</span>
        </summary>
        <div className="mt-2 space-y-2 border-t border-line pt-2">
          <p>{t('backup.scopeIncluded')}</p>
          <p>{t('backup.scopeExcluded')}</p>
          <p>{t('backup.scopeFiles')}</p>
        </div>
      </details>
      {settings && !settings.keystore && <p className="text-[12px] text-amber-700 dark:text-amber-300">{t('backup.keystoreOff')}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('backup.password')}>
          <PasswordInput secretLabel={t('backup.password')} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
        </Field>
        <Field label={t('backup.again')}>
          <PasswordInput secretLabel={t('backup.again')} value={again} onChange={(event) => setAgain(event.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" disabled={!settings?.keystore} checked={Boolean(settings?.keystore && remember)} onChange={(event) => setRemember(event.target.checked)} />
        <span>
          {t('backup.remember')}
          <span className="mt-1 block text-[12px] text-muted">{t(settings?.keystore ? 'backup.rememberHint' : 'backup.rememberUnavailable')}</span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <PrimaryButton
          onClick={() =>
            void run(async () => {
              if (password !== again) throw new Error(t('backup.mismatch'))
              const status = backup?.hasPassword
                ? await api().backup.unlock(password, Boolean(settings?.keystore && remember))
                : await api().backup.setPassword(password, Boolean(settings?.keystore && remember))
              patch({ backup: status })
              setPassword('')
              setAgain('')
              toast(t('toast.saved'))
            })
          }
        >
          {backup?.hasPassword ? t('backup.unlock') : t('backup.set')}
        </PrimaryButton>
        {backup?.unlocked && (
          <QuietButton
            onClick={() =>
              void run(async () => {
                patch({ backup: await api().backup.lock() })
              })
            }
          >
            {t('backup.lock')}
          </QuietButton>
        )}
        <QuietButton
          onClick={() =>
            void run(async () => {
              const name = await api().backup.auto()
              if (!name) throw new Error(backup?.autoBackupNote || t('backup.unlock'))
              setLocals(await api().backup.list())
              patch({ backup: await api().backup.status() })
              toast(t('toast.backup'))
            })
          }
        >
          {t('backup.now')}
        </QuietButton>
      </div>
      {backup?.autoBackupNote && <p className="text-[12px] text-muted">{backup.autoBackupNote}</p>}
      {backup?.hasPassword && <details className="space-y-3 border-t border-line pt-3">
        <summary className="cursor-pointer text-[13px] font-medium">{t('backup.change')}</summary>
        <p className="text-[12px] leading-5 text-muted">{t('backup.oldBackups')}</p>
        <fieldset disabled={changing} className="space-y-3">
          <Field label={t('backup.current')}><PasswordInput secretLabel={t('backup.current')} value={current} autoComplete="current-password" onChange={(event) => setCurrent(event.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('backup.next')}><PasswordInput secretLabel={t('backup.next')} value={next} autoComplete="new-password" onChange={(event) => setNext(event.target.value)} /></Field>
            <Field label={t('backup.confirmNext')}><PasswordInput secretLabel={t('backup.confirmNext')} value={confirmNext} autoComplete="new-password" onChange={(event) => setConfirmNext(event.target.value)} /></Field>
          </div>
          <PrimaryButton onClick={() => void run(async () => {
            if (next !== confirmNext) throw new Error(t('backup.mismatch'))
            setChanging(true)
            try {
              const status = await api().backup.changePassword(current, next, Boolean(settings?.keystore && remember))
              patch({ backup: status })
              setCurrent(''); setNext(''); setConfirmNext(''); setPassword(''); setAgain('')
              toast(t('backup.changed'))
            } finally { setChanging(false) }
          })}>{t('backup.change')}</PrimaryButton>
        </fieldset>
      </details>}
      <p className="text-[12px] leading-5 text-muted">{t('backup.restorePasswordHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <QuietButton
          onClick={() =>
            void run(async () => {
              const file = await api().dialog.saveBackup()
              if (!file) return
              await api().backup.export(file, password || null)
              toast(t('toast.export'))
            })
          }
        >
          {t('backup.export')}
        </QuietButton>
        <QuietButton
          onClick={() =>
            void run(async () => {
              const file = await api().dialog.openBackup()
              if (!file) return
              await api().backup.import(file, password || null, mode)
              toast(t('toast.import'))
            })
          }
        >
          {t('backup.import')}
        </QuietButton>
        <select value={mode} onChange={(event) => setMode(event.target.value as 'merge' | 'replace')} className="h-9 px-2 text-[12px]">
          <option value="merge">{t('backup.merge')}</option>
          <option value="replace">{t('backup.replace')}</option>
        </select>
      </div>
      <div>
        <div className="mb-1 text-[12px] text-muted">{t('backup.local')}</div>
        {locals.length === 0 && <p className="text-[12px] text-muted">{t('backup.empty')}</p>}
        <div className="space-y-1">
          {locals.slice(0, 10).map((file) => (
            <div key={file.filePath} className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-mono text-muted">{file.name}</span>
              <button
                type="button"
                className="text-accent"
                onClick={() =>
                  void run(async () => {
                    await api().backup.import(file.filePath, password || null, mode)
                    toast(t('toast.import'))
                  })
                }
              >
                {t('backup.restore')}
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3 border-t border-line pt-3">
        <div className="text-[13px] font-medium">{t('backup.webdav')}</div>
        <p className="text-[12px] leading-5 text-muted">{t('backup.webdavScope')}</p>
        <Field label={t('backup.url')}><TextInput value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('backup.user')}><TextInput value={user} onChange={(event) => setUser(event.target.value)} /></Field>
          <Field label={t('backup.webdavPassword')}><PasswordInput secretLabel={t('backup.webdavPassword')} value={pass} placeholder={settings?.backup.webdav?.hasPassword ? t('host.keep') : ''} onChange={(event) => setPass(event.target.value)} /></Field>
        </div>
        <Field label={t('backup.dir')}><TextInput value={dir} onChange={(event) => setDir(event.target.value)} /></Field>
        <div className="flex gap-2">
          <QuietButton
            onClick={() =>
              void run(async () => {
                await api().settings.update({ webdav: { url, username: user, password: pass || undefined, remoteDir: dir } })
                toast(t('toast.saved'))
              })
            }
          >
            {t('host.save')}
          </QuietButton>
          <span data-webdav-push><QuietButton disabled={!!webdavBusy} onClick={() => void syncWebdav('push')}>{t('backup.push')}</QuietButton></span>
          <span data-webdav-pull><QuietButton disabled={!!webdavBusy} onClick={() => void syncWebdav('pull')}>{t('backup.pull')}</QuietButton></span>
        </div>
        {webdavBusy && <div data-webdav-progress role="status" className="flex items-center gap-3 text-[12px] text-muted"><span>{t(webdavBusy === 'push' ? 'backup.webdavUploading' : 'backup.webdavDownloading')}</span><span data-webdav-cancel><QuietButton disabled={canceling} onClick={() => {
          const requestId = webdavRequest.current
          if (!requestId) return
          setCanceling(true)
          void api().backup.cancelWebdav(requestId).catch(err => {
            if (webdavRequest.current === requestId) { setCanceling(false); setError(t(runbookError(err))) }
          })
        }}>{t(canceling ? 'backup.webdavCanceling' : 'confirm.cancel')}</QuietButton></span></div>}
      </div>
      <p data-backup-s3-note className="border-t border-line pt-3 text-[12px] leading-5 text-muted">{t('backup.s3Unavailable')}</p>
      {error && <p data-backup-error role="alert" className="text-[12px] text-red-600 dark:text-red-300">{error}</p>}
    </div>
  )
}

function Choice({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: [string, string][]
  onChange: (value: string) => void
}) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] text-muted">{label}</div>
      <div className="inline-flex rounded-lg border border-line p-0.5">
        {options.map(([id, text]) => (
          <button key={id} type="button" data-value={id} aria-pressed={value === id} onClick={() => onChange(id)} className={`h-7 rounded-md px-3 text-[12px] ${value === id ? 'bg-accent-soft text-accent' : 'text-muted'}`}>
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

async function update(patchSettings: Parameters<ReturnType<typeof api>['settings']['update']>[0]) {
  const settings = await api().settings.update(patchSettings)
  patch({ settings, sidebarCollapsed: settings.sidebarCollapsed })
}
