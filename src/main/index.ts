import { FxService } from './fx-service'
import { perfPreferences, perfStage, registerPerf } from './perf'
import { startWatchdog } from './watchdog'
import { sessionCounts } from './diagnostics'
import { SecurityService } from './security-service'
import { CollectService } from './collect-service'
import { getMainCapabilities, setMainCapabilities } from './ext/capabilities'
import { listSnippets } from './snippets'
import { RunbookService } from './runbook-service'
import { OpLog } from './oplog'
import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, session, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { ForwardManager } from './forwarding'
import { BackupService } from './backup/service'
import { registerIpc } from './ipc'
import { KnownHostFile } from './known-hosts-file'
import { logError, logInfo } from './logger'
import { openVault } from './persist'
import { seedDemo, SessionHub } from './sessions'
import { onDataNotice } from '../core/json-file'
import { startupFailureMessage } from '../core/startup-failure'
import type { AppInfo } from '../shared/types'
import { translate } from '../shared/i18n'
import { checkVersion } from './version-check'
import { UpdateService } from './update-service'
import { StatusTray } from './tray'
import appIconPath from '../../build/mac/icon.png?asset'
import type { ExtensionRuntime } from '../ext/api'
import type { ExtensionObservations } from '../ext/observations'

perfStage('main-imports-ready')
if (process.env.HOPLINE_USER_DATA) {
  app.setPath('userData', process.env.HOPLINE_USER_DATA)
}
app.setName('Hopline')
app.setAppUserModelId('app.hopline.desktop')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let mainWindow: BrowserWindow | null = null
let watchdog: ReturnType<typeof startWatchdog> | undefined
let language: 'zh' | 'en' = 'zh'
let forwards: ForwardManager | undefined
let hub: SessionHub | null = null
let collect: CollectService | null = null
let updates: UpdateService | undefined
let fx: FxService | undefined
let disposeExtensions: (() => void) | undefined
let statusTray: StatusTray | undefined
let dockIconSet = false
let desktopInitialized = false
let desktopStartupTimer: NodeJS.Timeout | undefined
let finalizeDesktopStartup: (() => void) | undefined
const runtimeListeners = new Set<(value: ExtensionRuntime) => void>()
const observationListeners = new Set<(value: ExtensionObservations) => void>()
let readObservations = (): ExtensionObservations => ({ records: {}, security: {} })
function runtime(): ExtensionRuntime { return { windowOpen: !!mainWindow && !mainWindow.isDestroyed(), backgroundStay: statusTray?.active ?? false } }
let lastRuntime = ''
function publishRuntime(): void {
  const value = runtime(), key = JSON.stringify(value)
  if (lastRuntime === key) return
  lastRuntime = key
  for (const listener of runtimeListeners) { try { listener({ ...value }) } catch { logError('扩展运行状态通知失败') } }
}
function publishObservations(): void {
  statusTray?.refresh()
  for (const listener of observationListeners) { try { listener(readObservations()) } catch { logError('扩展采集状态通知失败') } }
}
function openMainWindow(): void {
  if (quitState !== 'running' || !hub) return
  if (!mainWindow || mainWindow.isDestroyed()) void createWindow(hub).catch(error => logError('failed to reopen window', error))
  else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() }
}
let disposeIpc: (() => Promise<void>) | undefined
let quitState: 'running' | 'closing' | 'ready' = 'running'
let relaunchRequested = false
const shots = process.env.HOPLINE_SHOTS === '1'
const QUIT_CLOSE_TIMEOUT = 5000

function resolvedTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

async function initializeApplication(): Promise<SessionHub> {
  perfStage('services-start')
  const userData = app.getPath('userData')
  const dataNotices: NonNullable<AppInfo['dataNotices']> = []
  const stopNotices = onDataNotice((notice) => dataNotices.push(notice))
  let opened: ReturnType<typeof openVault>
  const known = new KnownHostFile(path.join(userData, 'known_hosts.json'))
  try {
    opened = openVault()
    known.load()
  } finally {
    stopNotices()
  }
  const { vault, save } = opened
  perfStage('vault-open')
  updates = new UpdateService(userData, app.getVersion(), {
    onAvailable: (release) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:available', release)
    }
  })
  fx = new FxService(userData, {
    context: () => ({ hosts: vault.listHosts(), settings: vault.settingsPublic(false) }),
    onChanged: value => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fx:updated', value) }
  })
  if (process.env.HOPLINE_DEMO === '1' || shots) {
    const port = Number(process.env.HOPLINE_SSH_PORT || 0)
    seedDemo(
      vault,
      port
        ? {
            host: process.env.HOPLINE_SSH_HOST || '127.0.0.1',
            port,
            username: process.env.HOPLINE_SSH_USER || process.env.USER || 'ubuntu',
            keyPath: process.env.HOPLINE_SSH_KEY || ''
          }
        : undefined
    )
    save()
  }
  const backup = new BackupService(
    vault,
    path.join(userData, 'backup'),
    path.join(userData, 'backup-key.bin'),
    save
  )
  await backup.init()
  perfStage('backup-ready')
  const preference = vault.snapshot().settings.theme
  nativeTheme.themeSource = preference === 'system' ? 'system' : preference

  const sessions = new SessionHub(vault, known, (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }, userData)
  perfStage('sessions-ready')
  const security = new SecurityService(userData, sessions.pool, new OpLog(path.join(userData, 'oplog')), (id) => !!vault.getHost(id), () => { collect?.securityUpdated(); publishObservations() })
  collect = new CollectService({
    overviewHostLimit: () => getMainCapabilities().overviewHostLimit,
    preferences: () => vault.settingsPublic(false),
    securityScore: (id) => security.latest(id)?.score,
    pool: sessions.pool, hosts: () => vault.listHosts(), filePath: path.join(userData, 'snapshots.json'),
    updated: (records) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('collect:updated', records); publishObservations() }
  })
  perfStage('observations-ready')
  readObservations = () => ({ records: collect!.latest(), security: Object.fromEntries(vault.listHosts().flatMap(host => { const report = security.latest(host.id); return report ? [[host.id, { score: report.score, collectedAt: report.snapshot.collectedAt }]] : [] })) })
  forwards = new ForwardManager(sessions.pool, vault, (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  })
  sessions.autoStartForwards = (hostId) => forwards!.autoStart(hostId)
  hub = sessions
  for (const file of sessions.startupRecovered) dataNotices.push({ kind: 'recovered', path: file })
  if (sessions.startupRecoveryFailed) dataNotices.push({ kind: 'recovery-failed', path: sessions.startupRecoveryFailed })

  statusTray = new StatusTray({ hosts: () => vault.listHosts(), records: () => collect!.latest(), intervalMinutes: () => vault.settingsPublic(false).collectionIntervalMinutes, language: () => vault.snapshot().settings.language, open: openMainWindow, quit: () => app.quit() })
  const refreshDesktop = () => {
    collect?.settingsChanged()
    try { statusTray!.setEnabled(vault.snapshot().settings.backgroundStay) } catch { logError('菜单栏图标不可用') }
    publishRuntime(); publishObservations()
  }
  finalizeDesktopStartup = () => {
    if (desktopInitialized || quitState !== 'running') return
    desktopInitialized = true
    refreshDesktop()
    perfStage('tray-ready')
    if (process.platform === 'darwin' && !app.isPackaged && !dockIconSet) {
      perfStage('dock-start')
      try { app.dock?.setIcon(appIconPath); dockIconSet = true }
      catch (error) { logError('could not set development Dock icon', error) }
      perfStage('dock-ready')
    }
  }

  disposeIpc = registerIpc({
    onChanged: refreshDesktop,
    updates,
    fx,
    versionChange: checkVersion(userData, app.getVersion()),
    security,
    runbook: new RunbookService(sessions.pool, new OpLog(path.join(userData, 'oplog')), (id) => !!vault.getHost(id),
      (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('runbook:progress', event) }),
    collect,
    forwards,
    vault,
    save,
    sessions,
    backup,
    getWindow: () => mainWindow,
    shots,
    version: app.getVersion(),
    userData,
    dataNotices,
    keystoreReadFailed: opened.keystoreReadFailed,
    onRelaunch: () => {
      if (quitState !== 'running' || relaunchRequested) return
      app.relaunch()
      relaunchRequested = true
      app.quit()
    },
    watchdogPong: (id) => watchdog?.pong(id),
    onTheme: (theme) => {
      nativeTheme.themeSource = theme === 'system' ? 'system' : theme
    },
    resolvedTheme,
    onLanguage: (language) => buildMenu(language)
  })
  perfStage('ipc-ready')

  if (typeof __HOPLINE_EDITION__ !== 'undefined' && __HOPLINE_EDITION__ === 'pro') {
    const { loadMainExtensions, disposeMainExtensions } = await import('./ext')
    const { commandServices } = await import('./ext/services')
    disposeExtensions = disposeMainExtensions
    await loadMainExtensions(() => mainWindow, userData, () => vault.listHosts(), {
      secretsFor: owner => ({
        has: slot => vault.extensionSecretHas(owner, slot),
        get: slot => vault.extensionSecretGet(owner, slot),
        set: (slot, value) => vault.transaction(() => { vault.extensionSecretSet(owner, slot, value); save() })
      }),
      collect: id => collect!.runBackground(id),
      observations: readObservations,
      onObservations: listener => { observationListeners.add(listener); return () => { observationListeners.delete(listener) } },
      runtime,
      onRuntime: listener => { runtimeListeners.add(listener); return () => { runtimeListeners.delete(listener) } },
      openMainWindow,
      version: app.getVersion(), language: () => vault.snapshot().settings.language, listGroups: () => vault.listGroups(), listSnippets,
      ...commandServices(sessions.pool, id => vault.listHosts().find(host => host.id === id), new OpLog(path.join(userData, 'oplog'))),
      setCapabilities(value) {
        setMainCapabilities(value)
        collect?.settingsChanged()
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:capabilities', getMainCapabilities())
      }
    })
  }

  nativeTheme.on('updated', () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.send('theme:changed', { theme: resolvedTheme() })
    win.setBackgroundColor(resolvedTheme() === 'dark' ? '#121211' : '#f3f1ec')
  })

  buildMenu(vault.snapshot().settings.language)
  perfStage('services-ready')
  return sessions
}

async function createWindow(sessions: SessionHub): Promise<void> {
  const userData = app.getPath('userData')
  const bounds = visibleBounds(readBounds(path.join(userData, 'window.json')))
  let normalBounds = bounds ? { ...bounds } : undefined
  const mac = process.platform === 'darwin'
  perfStage('window-start')
  mainWindow = new BrowserWindow({
    width: shots ? 1440 : bounds?.width ?? 1160,
    height: shots ? 900 : bounds?.height ?? 740,
    x: shots ? undefined : bounds?.x,
    y: shots ? undefined : bounds?.y,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Hopline',
    icon: mac ? undefined : appIconPath,
    backgroundColor: resolvedTheme() === 'dark' ? '#121211' : '#f3f1ec',
    frame: mac,
    thickFrame: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    autoHideMenuBar: !mac,
    webPreferences: {
      ...perfPreferences(),
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      allowRunningInsecureContent: false
    }
  })
  perfStage('window-created')

  publishRuntime()
  const win = mainWindow
  const collectWhileVisible = () => collect?.setWindowOpen(win.isVisible() && !win.isMinimized())
  win.on('show', collectWhileVisible)
  win.on('restore', collectWhileVisible)
  win.on('focus', collectWhileVisible)
  win.on('hide', () => collect?.setWindowOpen(false))
  win.on('minimize', () => collect?.setWindowOpen(false))
  registerPerf(win)
  win.webContents.setBackgroundThrottling(false)
  watchdog = startWatchdog(win, () => sessionCounts(sessions), () => {
    dialog.showErrorBox(translate(language, 'diagnostics'), translate(language, 'rendererCrashed'))
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
  })
  const ses = win.webContents.session
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  if (app.isPackaged) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'"
          ]
        }
      })
    })
  }

  const recordNormalBounds = () => {
    if (win.isDestroyed() || win.isMaximized?.() || win.isMinimized?.()) return
    normalBounds = win.getBounds()
  }
  win.on('resize', recordNormalBounds)
  win.on('move', recordNormalBounds)
  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized', { maximized: true })
  })
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized', { maximized: false })
  })
  win.on('close', () => {
    if (win.isDestroyed()) return
    win.webContents.send('hosts:clearRevealed')
    const box = (win.isMaximized?.() || win.isMinimized?.()) && normalBounds ? normalBounds : win.getBounds()
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(path.join(userData, 'window.json'), JSON.stringify(box))
  })
  win.on('closed', () => {
    void sessions.closeAll()
    mainWindow = null
    collect?.setWindowOpen(false)
    collect?.setOverviewOpen(false)
    publishRuntime()
  })
  win.once('ready-to-show', () => {
    perfStage('window-ready-to-show')
    win.show()
    if (!desktopInitialized && !desktopStartupTimer) {
      desktopStartupTimer = setTimeout(() => {
        desktopStartupTimer = undefined
        finalizeDesktopStartup?.()
      }, 150)
      desktopStartupTimer.unref()
    }
    if (process.env.HOPLINE_SMOKE === '1') {
      fs.writeFileSync(path.join(userData, 'smoke-ok'), 'ok')
      setTimeout(() => app.exit(0), 400)
    }
  })
  if (shots) {
    win.webContents.on('console-message', (details) => {
      if (details.message.includes('HOPLINE_SHOTS_DONE')) setTimeout(() => app.exit(0), 300)
    })
  }

  try {
    // Defer native Tray and development Dock icon setup until after first window paint.
    // Packaged macOS apps already get the same Mark from their bundle's ICNS.
    perfStage('renderer-load-start')
    const loading = process.env.ELECTRON_RENDERER_URL
      ? win.loadURL(process.env.ELECTRON_RENDERER_URL)
      : win.loadFile(path.join(__dirname, '../renderer/index.html'))
    await loading
    perfStage('renderer-loaded')
  } catch (error) {
    logError('failed to load renderer', error)
    throw error
  }
  logInfo('window ready')
}

function buildMenu(locale: 'zh' | 'en'): void {
  language = locale
  const send = (command: string) => {
    const win = mainWindow
    if (win && !win.isDestroyed()) win.webContents.send('menu:command', command)
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(locale, process.platform, app.isPackaged, send)))
}

export function menuTemplate(
  locale: 'zh' | 'en', platform: string, packaged: boolean, send: (command: string) => void
): Electron.MenuItemConstructorOptions[] {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key)
  const mod = platform === 'darwin' ? 'CommandOrControl' : 'Ctrl+Shift'
  return [
    ...(platform === 'darwin'
      ? [{
          label: 'Hopline',
          submenu: [
            { label: t('about'), click: () => send('about') },
            { type: 'separator' as const },
            { label: t('settings'), accelerator: 'Command+,', click: () => send('settings') },
            { type: 'separator' as const },
            { role: 'hide' as const, label: t('hide') },
            { role: 'hideOthers' as const, label: t('hideOthers') },
            { role: 'unhide' as const, label: t('unhide') },
            { type: 'separator' as const },
            { role: 'quit' as const, label: t('quitApp') }
          ]
        }]
      : []),
    {
      label: t('file'),
      submenu: [
        { label: t('newLocal'), accelerator: `${mod}+T`, click: () => send('new-local') },
        { label: t('newHost'), accelerator: `${mod}+N`, click: () => send('new-host') },
        { type: 'separator' },
        { label: t('backup'), click: () => send('backup-now') },
        { type: 'separator' },
        { label: t('closeTab'), accelerator: `${mod}+W`, click: () => send('close-tab') },
        ...(platform === 'darwin' ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: t('quit') }])
      ]
    },
    {
      label: t('edit'),
      submenu: [
        { role: 'undo', label: t('undo') },
        { role: 'redo', label: t('redo') },
        { type: 'separator' },
        { role: 'cut', label: t('cut') },
        { role: 'copy', label: t('copy') },
        { role: 'paste', label: t('paste') },
        { role: 'selectAll', label: t('selectAll') }
      ]
    },
    {
      label: t('view'),
      submenu: [
        { label: t('palette'), accelerator: `${mod}+K`, click: () => send('palette') },
        { label: t('find'), accelerator: `${mod}+F`, click: () => send('find') },
        { label: t('sidebar'), accelerator: `${mod}+B`, click: () => send('toggle-sidebar') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('fullscreen') },
        ...(!packaged ? [{ type: 'separator' as const }, { role: 'reload' as const, label: t('reload') }, { role: 'toggleDevTools' as const, label: t('devTools') }] : [])
      ]
    },
    {
      label: t('window'),
      submenu: [{ role: 'minimize', label: t('minimize') }, { role: 'zoom', label: t('zoom') }, { type: 'separator' }, { role: 'front', label: t('front') }]
    },
    { label: t('help'), submenu: [{ label: t('diagnostics'), click: () => send('diagnostics') }, { label: t('checkUpdates'), click: () => send('check-updates') }] }
  ]
}

function readBounds(file: string): { x?: number; y?: number; width: number; height: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { x?: number; y?: number; width: number; height: number }
    if (!parsed.width || !parsed.height) return null
    return parsed
  } catch {
    return null
  }
}

function visibleBounds(
  box: { x?: number; y?: number; width: number; height: number } | null
): { x?: number; y?: number; width: number; height: number } | null {
  if (!box) return null
  try {
    const displays = screen.getAllDisplays()
    if (!displays.length) return box
    if (typeof box.x === 'number' && typeof box.y === 'number') {
      const visible = displays.some(({ workArea }) => {
        const overlapX = Math.min(box.x! + box.width, workArea.x + workArea.width) - Math.max(box.x!, workArea.x)
        const overlapY = Math.min(box.y! + box.height, workArea.y + workArea.height) - Math.max(box.y!, workArea.y)
        return overlapX >= 80 && overlapY >= 60
      })
      if (visible) return box
    }
    const primary = screen.getPrimaryDisplay().workArea
    return {
      width: Math.max(860, Math.min(box.width, primary.width)),
      height: Math.max(560, Math.min(box.height, primary.height))
    }
  } catch {
    return box
  }
}

if (gotLock) {
  app.whenReady().then(async () => {
    perfStage('app-ready')
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    const sessions = await initializeApplication()
    // Install reopen handlers only after application services and IPC are ready.
    // createWindow assigns mainWindow synchronously, before loading the renderer.
    const activate = openMainWindow
    app.on('activate', activate)
    app.on('second-instance', activate)
    await createWindow(sessions)
    // Test harnesses use temporary profiles and inject update responses; never
    // contact GitHub while running those local acceptance suites.
    if (process.env.HOPLINE_DISABLE_UPDATE_CHECK !== '1' && !shots) updates?.start()
    if (process.env.HOPLINE_DISABLE_FX_CHECK !== '1' && !shots) fx?.start()
  }).catch((error) => {
    logError('startup failed', error)
    const notice = startupFailureMessage(error)
    if (notice) dialog.showErrorBox(notice.title, notice.message)
    app.exit(1)
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !desktopInitialized && quitState === 'running') {
      clearTimeout(desktopStartupTimer)
      desktopStartupTimer = undefined
      finalizeDesktopStartup?.()
    }
    if (process.platform !== 'darwin' && !statusTray?.active) app.quit()
  })
  app.on('before-quit', (event) => {
    clearTimeout(desktopStartupTimer)
    desktopStartupTimer = undefined
    statusTray?.dispose()
    disposeExtensions?.(); disposeExtensions = undefined
    updates?.stop()
    fx?.stop()
    collect?.stop()
    if (quitState === 'ready' || !hub && !disposeIpc) {
      logInfo('quit')
      return
    }
    // Close sessions first so unsynced remote edits reach recovered/ before exit.
    event.preventDefault()
    if (quitState === 'closing') return
    quitState = 'closing'
    void (async () => {
      await disposeIpc?.()
      disposeIpc = undefined
      if (hub) await closeWithin(hub, QUIT_CLOSE_TIMEOUT)
    })().catch(error => logError('quit cleanup failed', error)).finally(() => {
      quitState = 'ready'
      if (relaunchRequested) app.exit(0)
      else app.quit()
    })
  })
}

async function closeWithin(sessions: SessionHub, timeout: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logError('closing sessions and connections before quit timed out')
      resolve()
    }, timeout)
  })
  try {
    const closing = (async () => {
      try {
        await sessions.closeAll()
      } finally {
        await forwards?.stopAll()
        await sessions.pool.closeAll()
      }
    })()
    await Promise.race([closing, expired])
  } finally {
    clearTimeout(timer)
  }
}
