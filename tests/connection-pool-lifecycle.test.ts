import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  directory: '',
  handlers: new Map<string, (...args: any[]) => any>(),
  backupCreated: vi.fn(),
  backupInit: vi.fn(async () => {}),
  sessionsCreated: vi.fn(),
  closeAll: vi.fn(),
  poolClose: vi.fn(),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  importFrom: vi.fn(),
  webdav: vi.fn(),
  startupRecovered: [] as string[],
  startupRecoveryFailed: null as string | null,
  openLocal: vi.fn(() => ({ id: 'local', kind: 'local' })),
  send: null as null | ((channel: string, payload: unknown) => void)
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    static windows: Window[] = []
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(() => { if (this.destroyed) throw new Error('destroyed window') }),
      setBackgroundThrottling: vi.fn(), setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    })
    loadFile = vi.fn(async () => {})
    loadURL = vi.fn(async () => {})
    show = vi.fn()
    focus = vi.fn()
    restore = vi.fn()
    isMinimized = () => false
    setBackgroundColor = vi.fn()
    getBounds = () => ({ x: 10, y: 10, width: 1100, height: 700 })
    isDestroyed = () => this.destroyed
    constructor(_options: unknown) { super(); Window.windows.push(this) }
    close() {
      this.emit('close')
      this.destroyed = true
      Window.windows = Window.windows.filter((win) => win !== this)
      this.emit('closed')
    }
    static getAllWindows() { return Window.windows }
  }
  return {
    BrowserWindow: Window,
    app: Object.assign(new EventEmitter(), {
      setName: vi.fn(), setAppUserModelId: vi.fn(), setPath: vi.fn(),
      requestSingleInstanceLock: () => true, quit: vi.fn(), exit: vi.fn(),
      getPath: () => state.directory, getVersion: () => 'test', getLocale: () => 'zh',
      whenReady: () => Promise.resolve(), isPackaged: false
    }),
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' }),
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (template: unknown) => template },
    session: { defaultSession: { setPermissionRequestHandler: vi.fn() } },
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => any) => {
        if (state.handlers.has(channel)) throw new Error(`duplicate IPC: ${channel}`)
        state.handlers.set(channel, handler)
      },
      on: vi.fn()
    },
    shell: {}, clipboard: {}, dialog: {}
  }
})
vi.mock('../src/main/backup/service', () => ({
  BackupService: class {
    constructor(...args: unknown[]) { state.backupCreated(...args) }
    init = state.backupInit
    status = () => ({ unlocked: true })
    scheduleAuto = vi.fn()
    importFrom = state.importFrom
    webdav = state.webdav
  }
}))
vi.mock('../src/main/sessions', () => ({
  SessionHub: class {
    constructor(vault: unknown, known: unknown, send: typeof state.send) {
      state.sessionsCreated(vault, known)
      state.send = send
    }
    pool = { closeAll: state.poolClose, invalidate: state.invalidate, invalidateAll: state.invalidateAll }
    closeHost = vi.fn(async () => {})
    closeAll = state.closeAll
    openLocal = state.openLocal
    startupRecovered = state.startupRecovered
    startupRecoveryFailed = state.startupRecoveryFailed
  },
  seedDemo: vi.fn()
}))
vi.mock('../src/main/secrets', () => ({
  safeStorageAvailable: () => true,
  createSafeCodec: () => ({ encrypt: (value: string) => value, decrypt: (value: string) => value })
}))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

import { app, BrowserWindow, nativeTheme } from 'electron'

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.handlers.clear()
  state.closeAll.mockReset().mockResolvedValue(undefined)
  state.poolClose.mockReset().mockResolvedValue(undefined)
  state.importFrom.mockReset().mockResolvedValue(undefined)
  state.webdav.mockReset().mockResolvedValue(undefined)
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-lifecycle-'))
  state.backupInit.mockResolvedValue(undefined)
  state.startupRecovered = []
  state.startupRecoveryFailed = null
  app.removeAllListeners()
  nativeTheme.removeAllListeners()
  vi.stubGlobal('__dirname', state.directory)
})
afterEach(() => {
  vi.useRealTimers()
  BrowserWindow.getAllWindows().forEach((win) => win.close())
  fs.rmSync(state.directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const invoke = (channel: string, win: Electron.BrowserWindow, ...args: unknown[]) =>
  state.handlers.get(channel)!({ sender: win.webContents }, ...args)
const ready = async () => {
  await vi.waitFor(() => expect(BrowserWindow.getAllWindows()).toHaveLength(1))
  await vi.waitFor(() => expect(state.handlers.has('app:info')).toBe(true))
  return BrowserWindow.getAllWindows()[0]!
}

describe('connection pool lifecycle and IPC', () => {
  it('m: closes sessions before the pool and waits for both before quitting', async () => {
    await import('../src/main/index')
    await ready()
    let finishSessions!: () => void
    let finishPool!: () => void
    state.closeAll.mockReturnValueOnce(new Promise<void>((resolve) => { finishSessions = resolve }))
    state.poolClose.mockReturnValueOnce(new Promise<void>((resolve) => { finishPool = resolve }))
    app.emit('before-quit', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(state.closeAll).toHaveBeenCalledTimes(1))
    expect(state.poolClose).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
    finishSessions()
    await vi.waitFor(() => expect(state.poolClose).toHaveBeenCalledTimes(1))
    expect(app.quit).not.toHaveBeenCalled()
    finishPool()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
  })

  it('m: session and pool shutdown share the same five-second deadline', async () => {
    await import('../src/main/index')
    await ready()
    vi.useFakeTimers()
    state.closeAll.mockImplementationOnce(() => new Promise<void>((resolve) => setTimeout(resolve, 3000)))
    state.poolClose.mockReturnValueOnce(new Promise<void>(() => {}))
    app.emit('before-quit', { preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(2999)
    expect(state.poolClose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(state.poolClose).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('leaves idle pool reclamation to the pool when only the window closes', async () => {
    await import('../src/main/index')
    const win = await ready()
    win.close()
    await vi.waitFor(() => expect(state.closeAll).toHaveBeenCalledTimes(1))
    expect(state.poolClose).not.toHaveBeenCalled()
  })

  it('invalidates saved and deleted host configurations using the unchanged IPC payloads', async () => {
    await import('../src/main/index')
    const win = await ready()
    const input = { groupId: null, name: '测试', host: 'example.test', port: 22, username: 'hop', authType: 'password' }
    const saved = invoke('hosts:save', win, input)
    expect(state.invalidate).toHaveBeenLastCalledWith(saved.id)
    invoke('hosts:save', win, { ...input, id: saved.id, host: 'new.test' })
    expect(state.invalidate).toHaveBeenCalledTimes(2)
    expect(state.invalidate).toHaveBeenLastCalledWith(saved.id)
    invoke('hosts:delete', win, saved.id)
    expect(state.invalidate).toHaveBeenCalledTimes(3)
    expect(state.invalidate).toHaveBeenLastCalledWith(saved.id)
    expect(() => invoke('hosts:save', win, { ...input, host: '' })).toThrow()
    expect(state.invalidate).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['backup:import', 'replace'],
    ['backup:import', 'merge'],
    ['backup:webdav', 'replace'],
    ['backup:webdav', 'merge']
  ])('invalidates only after a successful import through %s (%s)', async (channel, mode) => {
    await import('../src/main/index')
    const win = await ready()
    const backup = channel === 'backup:import' ? state.importFrom : state.webdav
    const firstArg = channel === 'backup:import' ? '/backup.hopline-backup' : 'pull'
    let finish!: () => void
    backup.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    const pending = invoke(channel, win, firstArg, null, mode, 'restore-request')
    expect(state.invalidateAll).not.toHaveBeenCalled()
    finish()
    await pending
    expect(state.invalidateAll).toHaveBeenCalledTimes(1)
    backup.mockRejectedValueOnce(new Error('导入失败'))
    await expect(invoke(channel, win, firstArg, null, mode, 'failed-restore-request')).rejects.toThrow('导入失败')
    expect(state.invalidateAll).toHaveBeenCalledTimes(1)
  })

  it.each(['replace', 'merge'])('does not invalidate host connections when pushing a backup (%s)', async (mode) => {
    await import('../src/main/index')
    const win = await ready()
    await invoke('backup:webdav', win, 'push', null, mode, 'push-request')
    expect(state.invalidateAll).not.toHaveBeenCalled()
  })
})
