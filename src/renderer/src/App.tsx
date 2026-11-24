import { PasswordInput } from './components/PasswordInput'
import { localDateTime } from '../../core/reminders'
import { Bot, Files, PanelLeft, Search, X } from 'lucide-react'
import { Fragment, Suspense, lazy, useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react'
import type { HostKeyPrompt, HostPublic, KeyboardPrompt, MenuCommand, PersistentSession, SessionInfo, Snippet } from '@shared/types'
import { persistentActions, diagnosticsAction, forwardActions, shellOutputActions, overviewAction, moveSelection, paletteItems } from './logic/palette'
import { needsAttention } from './logic/notify'
import { visibleProgress, type TaskProgress } from './logic/progress'
import { watchTaskNotifications, updateTask } from './state/tabs'
import { openCleanup, openInit, openOpLog, openRunbook } from './state/runbook'
import { subscribePromptExpiry } from './state/prompts'
import { openSecurity } from './state/security'
import { subscribeForwards, toggleForward } from './state/forwards'
import { timezoneRunbook } from '../../core/runbook/samples'
import { shellMarks } from './terminal/marks'
import { useShellIntegration } from './logic/shell-integration'
import { Overview } from './components/Overview'
import { openOverview, watchOverview } from './state/overview'
import { extractVariables, matchSnippets, pasteSnippet } from './logic/snippet'
import { Sidebar } from './components/Sidebar'
import { DeferredTerminalStack } from './components/DeferredTerminalStack'
import { ConfirmDialog, IconButton, Mark, Modal, PrimaryButton, QuietButton, shortcutLabel, TextPromptDialog, Toasts, useT } from './components/ui'
import {
  api,
  closeTab,
  connectHost,
  errorText,
  getState,
  backupNow,
  notifyEditSync,
  queueAuthentication,
  respondAuthentication,
  openLocal,
  patch,
  reconnectTab,
  reloadCatalog,
  restoreLayout,
  watchLayout,
  themeOf,
  toast,
  toggleSidebar,
  upsertTab,
  upsertTransfer,
  shallowEqual,
  useAppSelector
} from './state'
import { terminalOf, writeTerminal } from './terminal/registry'
import { useExtensionPaletteActions, ExtensionWorkspace, useExtensionPageTitle } from './ext/mounts'
import { setRendererCapabilities } from './ext/capabilities'
import { Onboarding } from './components/Onboarding'
import { ViewBoundary } from './components/ViewBoundary'
import { navigate, openHost, openSessions } from './state/navigation'
import { WhatsNew } from './components/WhatsNew'
import { checkForUpdates, updateAvailable } from './state/updates'

function lazyComponent<T extends ComponentType<any>>(loader: () => Promise<T>) {
  let Component: ReturnType<typeof lazy<T>> | null = null
  const resolve = () => {
    Component ??= lazy(() => loader().then((mod) => ({ default: mod })).catch((error) => { Component = null; throw error }))
    return Component
  }
  return function DeferredView(props: ComponentProps<T>) {
    const Target = resolve()
    return <Suspense fallback={null}><Target {...props} /></Suspense>
  }
}

const DiagnosticsDialog = lazyComponent(() => import('./components/DiagnosticsDialog').then((m) => m.DiagnosticsDialog))
const DiskCleanup = lazyComponent(() => import('./components/DiskCleanup').then((m) => m.DiskCleanup))
const InitWizard = lazyComponent(() => import('./components/InitWizard').then((m) => m.InitWizard))
const SecurityDialogs = lazyComponent(() => import('./components/SecurityDialog').then((m) => m.SecurityDialogs))
const ForwardPanel = lazyComponent(() => import('./components/ForwardPanel').then((m) => m.ForwardPanel))
const ImportDialog = lazyComponent(() => import('./components/ImportDialog').then((m) => m.ImportDialog))
const RunbookDialogs = lazyComponent(() => import('./components/RunbookDialog').then((m) => m.RunbookDialogs))
const OpLogDialog = lazyComponent(() => import('./components/OpLogDialog').then((m) => m.OpLogDialog))
const SnippetVariables = lazyComponent(() => import('./components/SnippetForm').then((m) => m.SnippetVariables))
const HostDialog = lazyComponent(() => import('./components/HostDialog').then((m) => m.HostDialog))
const SettingsDialog = lazyComponent(() => import('./components/SettingsDialog').then((m) => m.SettingsDialog))
const SettingsPage = lazyComponent(() => import('./components/SettingsDialog').then((m) => m.SettingsPage))
const UnlockDialog = lazyComponent(() => import('./components/UnlockDialog').then((m) => m.UnlockDialog))
const HostWorkspace = lazyComponent(() => import('./components/HostWorkspace').then((m) => m.HostWorkspace))
const HostFiles = lazyComponent(() => import('./components/HostFiles').then((m) => m.HostFiles))
const BillingPage = lazyComponent(() => import('./components/BillingPage').then(m => m.BillingPage))
const ActivityCenter = lazyComponent(() => import('./components/ActivityCenter').then((m) => m.ActivityCenter))
const UpdateDialog = lazyComponent(() => import('./components/UpdateDialog').then((m) => m.UpdateDialog))

export function App() {
  const { ready, bootError, diagnosticsOpen } = useAppSelector((state) => ({
    ready: state.ready, bootError: state.bootError, diagnosticsOpen: Boolean(state.diagnosticsOpen)
  }), shallowEqual)

  useEffect(() => {
    const notify = (window as Window & { hoplinePerf?: () => void }).hoplinePerf
    if (!ready || bootError || !notify) return
    // Let the committed host list / onboarding panel paint before notifying main.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(notify) })
    return () => cancelAnimationFrame(frame)
  }, [ready, bootError])

  useEffect(() => {
    const bridge = api()
    let stop = false
    let stopLayout = () => {}
    void (async () => {
      try {
        const [info, osTheme, hosts, groups, settings, backup, capabilities] = await Promise.all([
          bridge.app.info(),
          bridge.app.theme(),
          bridge.hosts.list(),
          bridge.groups.list(),
          bridge.settings.get(),
          bridge.backup.status(),
          bridge.app.capabilities().catch(() => ({ overviewHostLimit: 5 }))
        ])
        if (stop) return
        setRendererCapabilities(capabilities)
        ;(window as Window & { hoplinePerfStage?: (name: 'catalog-ready') => void }).hoplinePerfStage?.('catalog-ready')
        patch({
          info,
          osTheme,
          hosts,
          groups,
          settings,
          backup,
          sidebarCollapsed: settings.sidebarCollapsed,
          ready: true
        })
        const existing = await bridge.watchdog.sessions()
        if (stop) return
        for (const session of existing) upsertTab(session)
        await restoreLayout()
        if (stop) return
        stopLayout = watchLayout()
        if (info.shots) {
          void runStoryboard().catch((error) => {
            console.error(error)
            console.log('HOPLINE_SHOTS_DONE')
          })
        }
      } catch (error) {
        patch({ bootError: errorText(error), ready: true })
      }
    })()
    if (bridge.fx) void bridge.fx.read().then(fx => { if (!stop) patch({ fx }) }).catch(() => {})
    const offs = [
      bridge.on('app:capabilities', setRendererCapabilities),
      bridge.on('updates:available', updateAvailable),
      bridge.on('fx:updated', value => patch({ fx: value })),
      bridge.on('watchdog:ping', (id: number) => bridge.watchdog.pong(id)),
      watchTaskNotifications(),
      subscribePromptExpiry(),
      watchOverview(),
      subscribeForwards(),
      bridge.on('ssh:data', (payload: { sessionId: string; data: Uint8Array }) => writeTerminal(payload.sessionId, payload.data)),
      bridge.on('pty:data', (payload: { sessionId: string; data: string }) => writeTerminal(payload.sessionId, payload.data)),
      bridge.on('ssh:status', (info: SessionInfo) => upsertTab(info, false, false)),
      bridge.on('pty:exit', (payload: { sessionId: string }) => {
        patch((current) => ({
          ...current,
          tabs: current.tabs.map((tab) => (tab.id === payload.sessionId ? { ...tab, status: 'closed' } : tab))
        }))
      }),
      bridge.on('hostkey:prompt', (prompt: HostKeyPrompt) => queueAuthentication({ ...prompt, kind: 'hostKey' })),
      bridge.on('kbd:prompt', (prompt: KeyboardPrompt) => queueAuthentication({ ...prompt, kind: 'keyboard' })),
      bridge.on('transfer:event', upsertTransfer),
      bridge.on('theme:changed', (payload: { theme: 'light' | 'dark' }) => patch({ osTheme: payload.theme })),
      bridge.on('store:changed', () => void reloadCatalog()),
      bridge.on('menu:command', (command: MenuCommand) => handleMenu(command)),
      bridge.on('edit:synced', notifyEditSync)
    ]
    const onKey = (event: KeyboardEvent) => {
      const mac = bridge.platform === 'darwin'
      if (mac ? !event.metaKey : !(event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey)) return
      // Shift changes the printable key for digits and commas on many layouts.
      const key = !mac && /^Digit[0-9]$/.test(event.code) ? event.code.slice(-1)
        : !mac && event.code === 'Comma' ? ',' : event.key.toLowerCase()
      if (event.metaKey && !event.shiftKey && !event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) &&
        (event.target as HTMLElement)?.closest('.terminal-surface') && shellMarks.get(getState().activeId ?? '')?.jump(event.key === 'ArrowUp' ? -1 : 1)) {
        event.preventDefault(); event.stopPropagation(); return
      }
      if (key === '0') {
        event.preventDefault()
        openOverview()
      } else if (key === 'k') {
        event.preventDefault()
        patch((current) => ({ ...current, paletteOpen: !current.paletteOpen }))
      } else if (key === 't') {
        event.preventDefault()
        void openLocal()
      } else if (key === 'n') {
        event.preventDefault()
        patch({ hostDialog: 'new', paletteOpen: false })
      } else if (key === 'b') {
        event.preventDefault()
        toggleSidebar()
      } else if (key === 'f') {
        event.preventDefault()
        if (getState().route.page === 'sessions') patch((current) => ({ ...current, findOpen: !current.findOpen }))
      } else if (key === 'w') {
        event.preventDefault()
        const activeId = getState().activeId
        if (activeId && getState().route.page === 'sessions') void closeTab(activeId)
      } else if (key === ',') {
        event.preventDefault()
        patch({ settingsOpen: 'appearance' })
      } else if (key === 'e' && event.shiftKey) {
        event.preventDefault()
        toggleSftp()
      } else if (/^[1-9]$/.test(key)) {
        const tab = getState().tabs[Number(key) - 1]
        if (tab) {
          event.preventDefault()
          openSessions(tab.id)
        }
      }
      if (!mac && event.defaultPrevented) event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      stop = true
      stopLayout()
      offs.forEach((off) => off())
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  return (
    <>
      <Appearance />
      {!ready ? (
        <div className="grid h-full place-items-center bg-canvas text-accent">
          <Mark className="h-10 w-10" />
        </div>
      ) : bootError ? (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-8 text-[13px]"><p className="max-w-lg break-words text-red-600 dark:text-red-300">{bootError}</p><div className="flex gap-3"><QuietButton onClick={() => window.location.reload()}>重新加载</QuietButton><QuietButton onClick={() => patch({ diagnosticsOpen: true })}>导出诊断</QuietButton></div></div>
      ) : <Workspace />}
      {diagnosticsOpen && <DiagnosticsDialog />}
    </>
  )
}

function Appearance() {
  const theme = useAppSelector(themeOf)
  const language = useAppSelector((state) => state.settings?.language)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN'
  }, [theme, language])
  return null
}

function DeferredModals() {
  const open = useAppSelector((state) => ({
    forwards: Boolean(state.forwardsOpen),
    host: Boolean(state.hostDialog),
    importSsh: Boolean(state.importSshConfigOpen),
    runbook: Boolean(state.runbookTarget),
    init: Boolean(state.initHost),
    cleanup: Boolean(state.cleanupHost),
    opLog: Boolean(state.opLogHost),
    security: Boolean(state.securityHost),
    settings: Boolean(state.settingsOpen),
    unlock: Boolean(state.unlockPending?.length),
    snippet: Boolean(state.snippetPrompt),
    update: Boolean(state.updateOpen)
  }), shallowEqual)
  return (
    <>
      {open.forwards && <ForwardPanel />}
      {open.host && <HostDialog />}
      {open.importSsh && <ImportDialog />}
      {open.runbook && <RunbookDialogs />}
      {open.init && <InitWizard />}
      {open.cleanup && <DiskCleanup />}
      {open.opLog && <OpLogDialog />}
      {open.security && <SecurityDialogs />}
      {open.settings && <SettingsDialog />}
      {open.unlock && <UnlockDialog />}
      {open.snippet && <SnippetVariables />}
      {open.update && <UpdateDialog />}
    </>
  )
}

function Workspace() {
  const state = useAppSelector(current => ({ route: current.route, tabs: current.tabs, activeId: current.activeId, sidebarCollapsed: current.sidebarCollapsed, hosts: current.hosts }), shallowEqual)
  const t = useT(), en = useAppSelector(s => s.settings?.language === 'en')
  const active = state.tabs.find(tab => tab.id === state.activeId) ?? null
  const route = state.route, sessions = route.page === 'sessions'
  const [settingsVisited, setSettingsVisited] = useState(false)
  useEffect(() => { void api().collect.overview(route.page === 'overview').catch(error => toast(errorText(error), 'err')) }, [route.page])
  useEffect(() => { if (route.page === 'settings') setSettingsVisited(true) }, [route.page])
  const [visitedHosts, setVisitedHosts] = useState<Record<string, import('./state/navigation').HostSection>>({})
  useEffect(() => {
    if (route.page === 'host') setVisitedHosts(previous => previous[route.hostId] === route.section ? previous : { ...previous, [route.hostId]: route.section })
  }, [route])
  const hostViews = route.page === 'host' ? { ...visitedHosts, [route.hostId]: route.section } : visitedHosts
  const host = route.page === 'host' ? state.hosts.find(host => host.id === route.hostId) : null
  const extensionTitle = useExtensionPageTitle(route.page === 'extension' ? route.id : undefined)
  const title = route.page === 'extension' ? extensionTitle
    : route.page === 'host' ? (host ? '' : (en ? 'Host unavailable' : '主机已删除'))
    : route.page === 'sessions' ? (en ? 'Sessions' : '会话')
    : route.page === 'help' ? (en ? 'Help' : '帮助')
    : ''
  return <div className="flex h-full bg-panel text-ink">
    {!state.sidebarCollapsed && <Sidebar />}
    <main className="flex min-w-0 flex-1 flex-col">
      <header className={`app-drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-4 ${window.hopline.platform === 'darwin' && state.sidebarCollapsed ? 'pl-[78px]' : ''}`}>
        {state.sidebarCollapsed && <IconButton label={en ? 'Expand sidebar' : '展开侧栏'} onClick={toggleSidebar}><PanelLeft className="h-4 w-4" /></IconButton>}
        {title && <h1 className="min-w-0 truncate text-[14px] font-semibold">{title}</h1>}
        <div className="no-drag ml-auto flex min-w-0 items-center gap-2">
          {!sessions && state.tabs.length > 0 && <button type="button" className="max-w-40 truncate rounded-md border border-line px-2 py-1 text-[12px] text-muted" onClick={() => openSessions()}>{en ? 'Sessions' : '会话'} · {state.tabs.length}</button>}
          {sessions && <QuietButton onClick={() => void openLocal()}>{en ? '+ Local terminal' : '+ 本地终端'}</QuietButton>}
          {sessions && active?.kind === 'ssh' && <IconButton label={t('sftp.title')} active={active.sftpOpen} onClick={toggleSftp}><Files className="h-4 w-4" /></IconButton>}
          <IconButton label={`${t('palette.placeholder')} ${shortcutLabel()}K`} onClick={() => patch({ paletteOpen: true })}><Search className="h-4 w-4" /></IconButton>
          {window.hopline.platform !== 'darwin' && <WindowButtons />}
        </div>
      </header>
      <DataNotices />
      <Onboarding>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col" style={sessions ? { display: 'none' } : undefined}>
            <ViewBoundary resetKey={JSON.stringify(route)}>
              {route.page === 'overview' && <Overview onOpenHost={openHost} />}
              {route.page === 'billing' && <BillingPage />}

              {route.page === 'activity' && <ActivityCenter />}
              {route.page === 'help' && <HelpPage />}
              {route.page === 'extension' && <ExtensionWorkspace id={route.id} />}
            </ViewBoundary>
            {(settingsVisited || route.page === 'settings') && <div className="flex min-h-0 flex-1 flex-col" style={route.page !== 'settings' ? { display: 'none' } : undefined}><ViewBoundary resetKey={route.page}><SettingsPage /></ViewBoundary></div>}
            {route.page === 'host' && !host && <div className="p-8 text-[13px] text-muted">{en ? 'This host was deleted. Select another host or return to Overview.' : '此主机已删除，请选择其他主机或返回总览。'}<button className="ml-3 text-accent" onClick={() => navigate({ page: 'overview' })}>{t('overview.title')}</button></div>}
            {Object.entries(hostViews).filter(([id]) => state.hosts.some(host => host.id === id)).map(([id, section]) => <div key={id} className="flex min-h-0 flex-1 flex-col" style={route.page !== 'host' || route.hostId !== id ? { display: 'none' } : undefined}><ViewBoundary resetKey={`${id}:${section}`}><HostWorkspace hostId={id} section={section} onSectionChange={next => openHost(id, next)} renderFiles={<HostFiles hostId={id} />} /></ViewBoundary></div>)}
          </div>
          <div className="flex min-h-0 flex-1 flex-col" style={!sessions ? { display: 'none' } : undefined}>
            <nav aria-label={en ? 'Terminal sessions' : '终端会话'} className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-canvas p-2">
              {state.tabs.map(tab => <div key={tab.id} className={`flex shrink-0 items-center rounded-md border ${tab.id === state.activeId ? 'border-line bg-panel' : 'border-transparent text-muted'}`}>
                <button type="button" onClick={() => openSessions(tab.id)} aria-current={tab.id === state.activeId ? 'page' : undefined} className="flex max-w-56 items-center gap-2 px-3 py-1.5 text-[12px]">
                  {needsAttention(tab.status, !!tab.unread, visibleProgress(tab.progress)?.state) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-600" />}
                  {tab.agent && <Bot className="h-3.5 w-3.5" />}<TabProgress progress={tab.progress} /><span className="truncate">{tab.title}</span>{tab.tmuxName && <span className="rounded border border-line px-1 text-[10px]">tmux</span>}
                </button><button type="button" aria-label={`${en ? 'Close session' : '关闭会话'} · ${tab.title}`} className="mr-1 rounded p-1 hover:bg-accent-soft" onClick={() => void closeTab(tab.id)}><X className="h-3 w-3" /></button>
              </div>)}
            </nav>
            <div className="flex min-h-0 flex-1">
              <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-term">
                <ViewBoundary>{state.tabs.length === 0 ? <Empty /> : <DeferredTerminalStack />}</ViewBoundary>
                {active?.tmuxMissing && !active.tmuxNoticeDismissed && <PersistentNotice id={active.id} />}
                {active && active.status !== 'connected' && active.status !== 'connecting' && <div className="absolute bottom-4 left-1/2 flex max-w-[95%] -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-[12px] shadow-lg"><span className="min-w-0 break-words">{active.message || t('term.disconnected')}</span>{active.kind === 'ssh' && <button type="button" className="shrink-0 text-accent" onClick={() => void reconnectTab(active.id)}>{t('term.reconnect')}</button>}</div>}
              </section>
              {sessions && active?.kind === 'ssh' && active.hostId && active.sftpOpen && <ViewBoundary resetKey={active.id}><div className="flex w-[380px] max-w-[45%] shrink-0"><HostFiles key={active.hostId} hostId={active.hostId!} terminalSessionId={active.id} fullWidth /></div></ViewBoundary>}
            </div>
          </div>
        </div>
      </Onboarding>
    </main>
      <ConnectingNotice />
      <Palette />
      <DeferredModals />
      <About />
      <ConfirmDialog />
      <TextPromptDialog />
      <AuthenticationDialog />
      <Toasts />
      <WhatsNew />
  </div>
}

function HelpPage() {
  const en = useAppSelector(s => s.settings?.language === 'en'), t = useT()
  return <section className="workspace-page"><h1 className="text-xl font-semibold">{en ? 'Help' : '帮助'}</h1><p className="my-4 text-[13px] leading-6 text-muted">{en ? 'Select a host to inspect its status. Open its terminal explicitly when you need a shell, or use Files for independent file access. Navigation preserves your open terminal sessions.' : '单击主机查看状态。需要命令行时点击「打开终端」，文件可从主机的「文件」页独立访问。切换导航会保留已打开的终端会话。'}</p><div className="flex flex-wrap gap-3"><QuietButton onClick={() => void checkForUpdates()}>{t('updates.check')}</QuietButton><QuietButton onClick={() => patch({ diagnosticsOpen: true })}>{en ? 'Export diagnostics' : '导出诊断'}</QuietButton><QuietButton onClick={() => patch({ aboutOpen: true })}>{en ? 'About HopLine' : '关于 HopLine'}</QuietButton><QuietButton onClick={() => patch({ paletteOpen: true })}>{t('palette.placeholder')} · {shortcutLabel()}K</QuietButton><QuietButton onClick={() => patch({ settingsOpen: 'backup' })}>{t('settings.backup')}</QuietButton></div><dl className="mt-8 grid max-w-lg grid-cols-2 gap-3 text-[13px]"><dt>{t('overview.title')}</dt><dd>{shortcutLabel()}0</dd><dt>{t('empty.local')}</dt><dd>{shortcutLabel()}T</dd><dt>{t('sidebar.new')}</dt><dd>{shortcutLabel()}N</dd><dt>{t('settings.title')}</dt><dd>{shortcutLabel()},</dd></dl></section>
}

function ConnectingNotice() {
  const connecting = useAppSelector((state) => state.connecting)
  const t = useT()
  return connecting ? (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full border border-line bg-panel px-3 py-1.5 text-[12px] shadow-lg">
      {t('connecting', { name: connecting })}
    </div>
  ) : null
}

function DataNotices() {
  const info = useAppSelector((state) => state.info)
  const t = useT()
  const [dismissed, setDismissed] = useState(false)
  const notices = info?.dataNotices
  if (dismissed || !notices?.length) return null
  return (
    <aside role="alert" className="mx-2 mb-1 rounded-xl border border-amber-500/40 bg-amber-500/15 p-3 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <strong>{t('dataNotice.title')}</strong>
        <IconButton label={t('toast.dismiss')} onClick={() => setDismissed(true)}><X className="h-4 w-4" /></IconButton>
      </div>
      <ul className="max-h-40 space-y-2 overflow-auto">
        {notices.map((notice) => (
          <li key={notice.path}>
            <p>{t(`dataNotice.${notice.kind}`)}</p>
            <p className="break-all text-muted">{notice.path}</p>
            <button type="button" className="mt-1 text-accent underline" onClick={() => {
              void api().shell.showItem(notice.path).catch((error) => toast(errorText(error), 'err'))
            }}>
              {t(info?.platform === 'darwin' ? 'toast.showInFinder' : 'toast.showInFolder')}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}


function WindowButtons() {
  const t = useT()
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const bridge = api()
    void bridge.window.isMaximized?.().then(setMaximized).catch(() => {})
    return bridge.on('window:maximized', (payload: { maximized: boolean }) => setMaximized(payload.maximized))
  }, [])
  return (
    <div className="no-drag -mr-4 ml-1 flex h-12 items-stretch">
      <button
        type="button"
        title={t('window.min')}
        aria-label={t('window.min')}
        onClick={() => void api().window.minimize()}
        className="grid w-11 place-items-center text-muted transition-colors hover:bg-black/6 hover:text-ink dark:hover:bg-white/8"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        title={t(maximized ? 'window.restore' : 'window.zoom')}
        aria-label={t(maximized ? 'window.restore' : 'window.zoom')}
        onClick={() => void api().window.zoom()}
        className="grid w-11 place-items-center text-muted transition-colors hover:bg-black/6 hover:text-ink dark:hover:bg-white/8"
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M3 1.5h5.5V7" stroke="currentColor" strokeWidth="1" />
            <rect x="1.5" y="3" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" rx="0.75" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        )}
      </button>
      <button
        type="button"
        title={t('window.close')}
        aria-label={t('window.close')}
        onClick={() => void api().window.close()}
        className="grid w-11 place-items-center text-muted transition-colors hover:bg-[#c42b1c] hover:text-white active:bg-[#b12618]"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1.75 1.75l6.5 6.5M8.25 1.75l-6.5 6.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

function Empty() {
  const t = useT()
  return (
    <div className="grid h-full place-items-center px-8 text-center">
      <div>
        <Mark className="mx-auto h-12 w-12" />
        <h1 className="mt-4 text-[22px] font-medium tracking-tight">HopLine</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13px] leading-6 text-muted">{t('app.tagline')}</p>
        <p className="mt-1 text-[13px] text-muted">{t('empty.body')}</p>
        <div className="mt-5 flex justify-center gap-2">
          <PrimaryButton onClick={() => void openLocal()}>{t('empty.local')}</PrimaryButton>
          <QuietButton onClick={() => patch({ hostDialog: 'new' })}>{t('empty.new')}</QuietButton>
        </div>
      </div>
    </div>
  )
}

function usePaletteSnippetActions() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const active = useAppSelector((state) => state.tabs.find((tab) => tab.id === state.activeId))
  const hosts = useAppSelector((state) => state.hosts)
  const t = useT()
  useEffect(() => {
    let stopped = false
    void api().snippets.list().then((items) => { if (!stopped) setSnippets(items) })
      .catch((error) => {
        if (!stopped) toast(t(errorText(error).match(/snippet\.(invalid|missing|limit|terminal)\b/)?.[0] ?? errorText(error)), 'err')
      })
    return () => { stopped = true }
  }, [])
  const hostId = active?.kind === 'ssh' && hosts.some((host) => host.id === active.hostId) ? active.hostId! : null
  return (active?.status === 'connected' ? matchSnippets(snippets, '', hostId) : []).map((snippet) => ({
    id: `snippet:${snippet.id}`, label: snippet.name, preview: snippet.command.replace(/[\r\n]+/g, ' '),
    matches: (query: string) => matchSnippets([snippet], query, hostId).length > 0,
    run: () => {
      if (extractVariables(snippet.command).length) patch({ snippetPrompt: { command: snippet.command, sessionId: active!.id } })
      else {
        const term = terminalOf(active!.id)
        if (!term || getState().tabs.find((tab) => tab.id === active!.id)?.status !== 'connected') {
          toast(t('snippet.terminal'), 'err')
          return
        }
        patch({ activeId: active!.id, route: { page: 'sessions' } })
        pasteSnippet(term, snippet.command, {})
        term.focus()
      }
    }
  }))
}

function Palette() {
  const open = useAppSelector((state) => state.paletteOpen)
  return open ? <PaletteContent /> : null
}

function PaletteContent() {
  const activeId = useAppSelector((state) => state.activeId)
  const integration = useShellIntegration(activeId)
  const tabs = useAppSelector((state) => state.tabs)
  const [remote, setRemote] = useState<{ host: HostPublic; sessions: PersistentSession[] } | null>(null)
  const listRequest = useRef(0)
  useEffect(() => () => { listRequest.current++ }, [])
  const forwards = useAppSelector((state) => state.forwards)
  const state = useAppSelector((current) => ({ hosts: current.hosts, query: current.query }), shallowEqual)
  const t = useT()
  const [selection, setSelection] = useState(0)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const kill = (hostId: string, name: string) => { void api().persistent.kill(hostId, name).catch((error) => toast(errorText(error), 'err')) }
  const actions = [
    ...persistentActions(state.hosts, tabs, t, (host) => { void connectHost(host, { persistent: true }) }, (host) => {
      const request = ++listRequest.current
      void api().persistent.list(host.id).then((sessions) => {
        if (request !== listRequest.current) return
        setRemote({ host, sessions }); setSelection(0); patch({ query: '' })
      }).catch((error) => toast(errorText(error), 'err'))
    }, kill),
    ...state.hosts.map((host) => ({ id: `cleanup:${host.id}`, preview: undefined, label: `${t('cleanup.title')}: ${host.name}`, run: () => openCleanup(host.id) })),
    ...state.hosts.map((host) => ({ id: `init:${host.id}`, preview: undefined, label: `${t('init.title')}: ${host.name}`, run: () => openInit(host.id) })),
    ...state.hosts.map((host) => ({ id: `security:${host.id}`, preview: undefined, label: `${t('security.title')}: ${host.name}`, run: () => openSecurity(host.id) })),
    { id: 'timezone', label: t('runbook.timezone'), run: () => openRunbook(timezoneRunbook) },
    ...shellOutputActions(integration.active, t('shellIntegration.copy'), () => {
      const output = shellMarks.get(activeId ?? '')?.output()
      if (output !== undefined) void api().clipboard.write(output).catch((error) => toast(errorText(error), 'err'))
    }),
    ...state.hosts.map((host) => ({ id: `oplog:${host.id}`, label: `${t('runbook.log')}: ${host.name}`, run: () => openOpLog(host.id) })),
    overviewAction(t('overview.open'), openOverview),
    { id: 'local', label: t('palette.local'), run: () => void openLocal() },
    { id: 'host', label: t('palette.host'), run: () => patch({ hostDialog: 'new' }) },
    { id: 'backup-now', label: t('backup.now'), run: () => void backupNow() },
    { id: 'backup', label: t('palette.backup'), run: () => patch({ settingsOpen: 'backup' }) },
    { id: 'side', label: t('palette.sidebar'), run: () => toggleSidebar() },
    { id: 'theme', label: t('palette.theme'), run: () => void toggleTheme() },
    { id: 'about', label: t('palette.about'), run: () => patch({ aboutOpen: true }) },
    { id: 'snippets', label: t('settings.snippets'), run: () => patch({ settingsOpen: 'snippets' }) },
    ...usePaletteSnippetActions(),
    { id: 'import-ssh-config', label: t('importSsh.title'), keywords: ['ssh config import 导入'], run: () => patch({ importSshConfigOpen: true }) },
    { id: 'forwards', label: t('forward.view'), run: () => patch({ forwardsOpen: true }) },
    ...forwardActions(state.hosts, forwards, t, toggleForward),
    ...useExtensionPaletteActions(),
    diagnosticsAction(t('diagnostics.title'), () => patch({ diagnosticsOpen: true }))
  ]
  const remoteActions = remote?.sessions.flatMap((session) => [
    { id: `attach:${session.name}`, label: `${session.name} · ${localDateTime(session.activity * 1000)} · ${session.attached}`, run: () => { void connectHost(remote.host, { tmuxName: session.name }) } },
    { id: `kill:${session.name}`, label: `${t('persistent.kill')}：${session.name}`, run: () => kill(remote.host.id, session.name) }
  ])
  const items = paletteItems(remote ? [] : state.hosts, remoteActions ?? actions, state.query)
  const selected = moveSelection(selection, 0, items.length)
  const selectedId = items[selected]?.id
  useEffect(() => setSelection(0), [state.query])
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])
  const close = () => patch({ paletteOpen: false, query: '' })
  const run = (index: number) => {
    const item = items[index]
    if (!item) return
    if (!(item.kind === 'action' && item.action.id.startsWith('persistent:list:'))) close()
    if (item.kind === 'host') void connectHost(item.host)
    else item.action.run()
  }
  return (
    <div className="fixed inset-0 z-40 bg-black/25 pt-[14vh] backdrop-blur-[2px]" onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.placeholder')}
        className="pop mx-auto w-[560px] max-w-[92vw] overflow-hidden rounded-2xl border border-line bg-panel shadow-[var(--shadow)]"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            setSelection(moveSelection(selected, event.key === 'ArrowUp' ? -1 : 1, items.length))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            run(selected)
          }
        }}
      >
        <input
          autoFocus
          role="combobox"
          aria-label={t('palette.placeholder')}
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={selectedId ? `palette-${selectedId}` : undefined}
          value={state.query}
          onChange={(event) => {
            setSelection(0)
            patch({ query: event.target.value })
          }}
          placeholder={t('palette.placeholder')}
          className="h-12 w-full border-0 bg-transparent px-4 text-[14px] shadow-none"
        />
        <div id="palette-list" role="listbox" aria-label={t('palette.placeholder')} className="scroll-thin max-h-80 overflow-y-auto border-t border-line p-2">
          {items.map((item, index) => (
            <Fragment key={item.id}>
              {(index === 0 || items[index - 1].kind !== item.kind) && (
                <div role="presentation" className="px-2 py-1 text-[11px] text-muted">{t(item.kind === 'host' ? 'palette.connect' : 'palette.actions')}</div>
              )}
              <button
                id={`palette-${item.id}`}
                ref={index === selected ? selectedRef : undefined}
                role="option"
                aria-selected={index === selected}
                tabIndex={-1}
                type="button"
                className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-[13px] ${index === selected ? 'bg-accent-soft text-accent' : ''}`}
                onMouseMove={(event) => {
                  // Chromium also emits stationary mouse moves during layout/scroll.
                  if (event.movementX || event.movementY) setSelection(index)
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run(index)}
              >
                <span className={item.kind === 'action' && 'preview' in item.action ? 'min-w-0 truncate' : undefined}>{item.kind === 'host' ? item.host.name : item.action.label}</span>
                {item.kind === 'action' && 'preview' in item.action && typeof item.action.preview === 'string' && <span className="ml-3 w-[55%] shrink-0 truncate whitespace-nowrap text-[12px] text-muted">{item.action.preview}</span>}
                {item.kind === 'host' && <span className="text-[12px] text-muted">{item.host.username}@{item.host.host}</span>}
              </button>
            </Fragment>
          ))}
          {items.length === 0 && <p className="px-2 py-6 text-center text-[12px] text-muted">{t(remote ? 'persistent.empty' : 'palette.empty')}</p>}
        </div>
        <div className="border-t border-line px-3 py-2 text-[11px] text-muted">{t('palette.hint')}</div>
      </div>
    </div>
  )
}

function About() {
  const open = useAppSelector((state) => state.aboutOpen)
  const info = useAppSelector((state) => state.info)
  const t = useT()
  return (
    <Modal open={open} title={t('about.title')} onClose={() => patch({ aboutOpen: false })} width="w-[440px]">
      <div className="flex gap-3">
        <Mark className="h-10 w-10" />
        <div>
          <div className="text-[15px] font-medium">HopLine</div>
          <div className="text-[12px] text-muted">{info?.version} · Electron {info?.electron}</div>
          <div className="text-[12px] text-muted">{t(`about.edition.${info?.edition ?? __HOPLINE_EDITION__}`)}</div>
          <p className="mt-3 text-[13px] leading-6 text-muted">{t('about.body')}</p>
        </div>
      </div>
    </Modal>
  )
}

function AuthenticationDialog() {
  const prompt = useAppSelector((state) => state.prompts[0])
  if (!prompt) return null
  return prompt.kind === 'hostKey'
    ? <HostKeyDialog key={prompt.requestId} prompt={prompt} />
    : <KeyboardDialog key={prompt.requestId} prompt={prompt} />
}

function HostKeyDialog({ prompt }: { prompt: HostKeyPrompt }) {
  const t = useT()
  const host = `${prompt.host.includes(':') ? `[${prompt.host}]` : prompt.host}:${prompt.port}`
  const answer = (decision: 'reject' | 'once' | 'save') => {
    void respondAuthentication({ ...prompt, kind: 'hostKey' }, decision)
  }
  return (
    <Modal open title={prompt.mismatch ? t('hostKey.mismatch') : t('hostKey.title')} onClose={() => answer('reject')} width="w-[460px]">
      <p className="text-[13px] leading-6 text-muted">{prompt.mismatch ? t('hostKey.mismatchBody', { host }) : t('hostKey.body', { host })}</p>
      <p className="mt-3 font-mono text-[12px] text-ink">{prompt.keyType}</p>
      <p className="mt-1 break-all font-mono text-[12px] text-accent">{prompt.fingerprint}</p>
      <div className="mt-5 flex justify-end gap-2">
        <QuietButton onClick={() => answer('reject')}>{t('hostKey.reject')}</QuietButton>
        <QuietButton onClick={() => answer('once')}>{t('hostKey.once')}</QuietButton>
        <PrimaryButton onClick={() => answer('save')}>{prompt.mismatch ? t('hostKey.update') : t('hostKey.save')}</PrimaryButton>
      </div>
    </Modal>
  )
}

function KeyboardDialog({ prompt }: { prompt: KeyboardPrompt }) {
  const t = useT()
  return (
    <Modal open title={prompt.name || t('kbd.title')} onClose={() => answer(null)} width="w-[460px]">
      {prompt.instructions && <p className="mb-3 text-[13px] text-muted">{prompt.instructions}</p>}
      <form
        id="kbd-form"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          answer(prompt.prompts.map((_, index) => String(data.get(`p${index}`) ?? '')))
        }}
      >
        {prompt.prompts.map((item, index) => (
          <label key={index} className="block text-[13px]">
            <span className="mb-1 block text-muted">{item.prompt}</span>
            {item.echo ? <input name={`p${index}`} type="text" autoFocus={index === 0} className="h-9 w-full px-3" /> : <PasswordInput secretLabel={item.prompt} name={`p${index}`} autoFocus={index === 0} />}
          </label>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <QuietButton onClick={() => answer(null)}>{t('kbd.cancel')}</QuietButton>
          <PrimaryButton type="submit">{t('kbd.ok')}</PrimaryButton>
        </div>
      </form>
    </Modal>
  )
  function answer(answers: string[] | null) {
    void respondAuthentication({ ...prompt, kind: 'keyboard' }, answers)
  }
}

function toggleSftp() {
  const route = getState().route
  if (route.page === 'host') { openHost(route.hostId, 'files'); return }
  if (route.page !== 'sessions') openSessions()
  const current = getState()
  patch({
    tabs: current.tabs.map((tab) => (tab.id === current.activeId ? { ...tab, sftpOpen: !tab.sftpOpen } : tab))
  })
}

function toggleTheme() {
  const next = themeOf() === 'dark' ? 'light' : 'dark'
  void api().settings.update({ theme: next }).then((settings) => patch({ settings, paletteOpen: false }))
}

function handleMenu(command: MenuCommand | 'diagnostics') {
  if (command === 'check-updates') void checkForUpdates()
  if (command === 'diagnostics') patch({ diagnosticsOpen: true })
  if (command === 'new-local') void openLocal()
  if (command === 'new-host') patch({ hostDialog: 'new' })
  const activeId = getState().activeId
  if (command === 'close-tab' && activeId && getState().route.page === 'sessions') void closeTab(activeId)
  if (command === 'palette') patch((current) => ({ ...current, paletteOpen: !current.paletteOpen }))
  if (command === 'toggle-sidebar') toggleSidebar()
  if (command === 'find') if (getState().route.page === 'sessions') patch((current) => ({ ...current, findOpen: !current.findOpen }))
  if (command === 'settings') patch({ settingsOpen: 'appearance' })
  if (command === 'about') patch({ aboutOpen: true })
  if (command === 'backup-now') void backupNow()
}

async function runStoryboard() {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const shot = async (name: string) => {
    await wait(250)
    await api().captureShot(name)
  }
  await document.fonts.ready
  await wait(400)
  await shot('01-welcome')
  patch({ paletteOpen: true, query: '' })
  await shot('02-palette')
  patch({ paletteOpen: false, hostDialog: 'new' })
  await shot('03-host')
  patch({ hostDialog: false })
  await openLocal()
  await wait(1400)
  await shot('04-terminal')
  const local = getState().hosts.find((host) => host.name === '本机')
  if (local) {
    const pending = connectHost(local)
    for (let i = 0; i < 40 && !getState().prompts.length; i++) await wait(100)
    const prompt = getState().prompts[0]
    if (prompt?.kind === 'hostKey') {
      await shot('05-hostkey')
      await respondAuthentication(prompt, 'save')
    }
    await pending
    await wait(300)
    toggleSftp()
    for (let i = 0; i < 30 && !document.querySelector('[data-ready="sftp"]'); i++) await wait(150)
    await shot('06-sftp')
  }
  patch({ settingsOpen: 'backup' })
  await shot('07-backup')
  patch({ settingsOpen: false })
  await api().settings.update({ theme: 'dark' }).then((settings) => patch({ settings }))
  await wait(250)
  await shot('08-dark')
  console.log('HOPLINE_SHOTS_DONE')
}

function TabProgress({ progress }: { progress?: TaskProgress | null }) {
  const ref = useRef<HTMLSpanElement>(null), current = visibleProgress(progress)
  useEffect(() => {
    if (current?.state !== 3) return
    const animation = ref.current?.animate([{ left: '0%' }, { left: '75%' }], { duration: 900, iterations: Infinity, direction: 'alternate' })
    return () => animation?.cancel()
  }, [current?.state])
  return current ? <span ref={ref} className={`absolute bottom-0 left-0 h-[2px] ${current.state === 2 ? 'bg-red-500' : current.state === 4 ? 'bg-amber-500' : 'bg-accent'}`}
    style={{ width: `${current.state === 3 ? 25 : current.value}%` }} /> : null
}

function PersistentNotice({ id }: { id: string }) {
  const t = useT()
  return <div role="status" className="absolute top-2 left-2 right-2 rounded-lg bg-panel p-2 text-[12px]">
    {t('persistent.missing')}
    <button className="ml-3 text-accent" onClick={() => void api().clipboard.write('if command -v apt-get >/dev/null; then sudo apt-get install tmux; elif command -v dnf >/dev/null; then sudo dnf install tmux; elif command -v apk >/dev/null; then sudo apk add tmux; fi')}>{t('persistent.install')}</button>
    <button className="ml-3" aria-label={t('toast.dismiss')} onClick={() => updateTask(id, { tmuxNoticeDismissed: true })}>×</button>
  </div>
}
