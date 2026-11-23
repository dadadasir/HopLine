import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  directory: '', order: [] as string[],
  register: vi.fn(), load: vi.fn(async () => {}), closeAll: vi.fn(async () => {})
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    static windows: Window[] = []
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(), setBackgroundThrottling: vi.fn(), setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    })
    loadFile = async () => { state.order.push('window-loaded') }
    isDestroyed = () => this.destroyed
    isMinimized = () => false
    focus = vi.fn()
    getBounds = () => ({ width: 1000, height: 700 })
    constructor() { super(); Window.windows.push(this) }
    close() {
      this.destroyed = true
      Window.windows = Window.windows.filter((win) => win !== this)
      this.emit('closed')
    }
    static getAllWindows() { return Window.windows }
  }
  return {
    BrowserWindow: Window,
    app: Object.assign(new EventEmitter(), {
      setName: vi.fn(), setAppUserModelId: vi.fn(), setPath: vi.fn(), quit: vi.fn(), exit: vi.fn(),
      requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
      getPath: () => state.directory, getVersion: () => 'test', getLocale: () => 'zh', isPackaged: false
    }),
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' }),
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (value: unknown) => value },
    session: { defaultSession: { setPermissionRequestHandler: vi.fn() } },
    shell: {}, dialog: {}
  }
})
vi.mock('../src/main/ipc', () => ({ registerIpc: state.register }))
vi.mock('../src/main/ext', () => ({ loadMainExtensions: state.load, disposeMainExtensions: vi.fn() }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('../src/main/persist', () => ({ openVault: () => ({
  vault: { listHosts: () => [], settingsPublic: () => ({ language: 'zh', displayCurrency: 'auto' }), snapshot: () => ({ settings: { theme: 'system' } }) }, save: vi.fn()
}) }))
vi.mock('../src/main/known-hosts-file', () => ({ KnownHostFile: class { load() {} } }))
vi.mock('../src/main/backup/service', () => ({ BackupService: class { async init() {} } }))
vi.mock('../src/main/sessions', () => ({
  SessionHub: class {
    startupRecovered = []
    startupRecoveryFailed = null
    closeAll = state.closeAll
  }, seedDemo: vi.fn()
}))
import { app, BrowserWindow, nativeTheme } from 'electron'

afterEach(() => {
  BrowserWindow.getAllWindows().forEach((win) => win.close())
  app.removeAllListeners()
  nativeTheme.removeAllListeners()
  fs.rmSync(state.directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('extension initialization boundary', () => {
  it.each(['community', 'pro'])('loads %s extensions once after core IPC and before the first window', async (edition) => {
    vi.resetModules()
    state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-ext-lifecycle-'))
    state.order = []
    vi.stubGlobal('__dirname', state.directory)
    vi.stubGlobal('__HOPLINE_EDITION__', edition)
    state.register.mockImplementation(() => { state.order.push('core-ipc') })
    let finish!: () => void
    state.load.mockImplementation(async () => {
      state.order.push('extensions-start')
      await new Promise<void>((resolve) => { finish = resolve })
      state.order.push('extensions-finish')
    })
    await import('../src/main/index')
    if (edition === 'pro') {
      await vi.waitFor(() => expect(state.load).toHaveBeenCalledTimes(1))
      expect(state.order).toEqual(['core-ipc', 'extensions-start'])
      expect(BrowserWindow.getAllWindows()).toHaveLength(0)
      finish()
    }
    await vi.waitFor(() => expect(BrowserWindow.getAllWindows()).toHaveLength(1))
    expect(state.order).toEqual(edition === 'pro'
      ? ['core-ipc', 'extensions-start', 'extensions-finish', 'window-loaded']
      : ['core-ipc', 'window-loaded'])
    for (let i = 0; i < 2; i++) {
      BrowserWindow.getAllWindows()[0].close()
      app.emit('activate')
      await vi.waitFor(() => expect(BrowserWindow.getAllWindows()).toHaveLength(1))
    }
    expect(state.register).toHaveBeenCalledTimes(1)
    expect(state.load).toHaveBeenCalledTimes(edition === 'pro' ? 1 : 0)
    expect(app.exit).not.toHaveBeenCalled()
  })
})
