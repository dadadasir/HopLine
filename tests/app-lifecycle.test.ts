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
      requestSingleInstanceLock: () => true, quit: vi.fn(), relaunch: vi.fn(), exit: vi.fn(),
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
  }
}))
vi.mock('../src/main/sessions', () => ({
  SessionHub: class {
    constructor(vault: unknown, known: unknown, send: typeof state.send) {
      state.sessionsCreated(vault, known)
      state.send = send
    }
    pool = { closeAll: vi.fn(async () => {}), invalidate: vi.fn(), invalidateAll: vi.fn() }
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
import { emptyStore } from '../src/core/vault'

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.handlers.clear()
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

describe('application lifecycle through the real entry point and IPC handlers', () => {
  it.each(['quarantined', 'rejected'] as const)('reports %s store data and quarantined known hosts on every window boot', async (kind) => {
    const store = kind === 'quarantined' ? '{broken' : JSON.stringify({ ...emptyStore(), hosts: [null] })
    fs.writeFileSync(path.join(state.directory, 'hopline-store.json'), store)
    fs.writeFileSync(path.join(state.directory, 'known_hosts.json'), '{broken')
    await import('../src/main/index')
    const win = await ready()
    const notices = invoke('app:info', win).dataNotices
    expect(notices).toHaveLength(2)
    expect(notices.map((notice: { kind: string }) => notice.kind)).toEqual([kind, 'quarantined'])
    for (const notice of notices) expect(fs.existsSync(notice.path)).toBe(true)
    expect(fs.readFileSync(notices[1].path, 'utf8')).toBe('{broken')
    win.close()
    app.emit('activate')
    expect(invoke('app:info', await ready()).dataNotices).toEqual(notices)
    expect(state.backupCreated).toHaveBeenCalledTimes(1)
    // Startup collection is detached afterwards, including on subsequent reads.
    const { writeRejectedJsonFile } = await import('../src/core/json-file')
    writeRejectedJsonFile(path.join(state.directory, 'later.json'), {})
    expect(notices).toHaveLength(2)
  })

  it('does not initialize a second application while startup is awaiting backup init', async () => {
    let finish!: () => void
    state.backupInit.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    await import('../src/main/index')
    await vi.waitFor(() => expect(state.backupInit).toHaveBeenCalledTimes(1))
    app.emit('activate')
    await Promise.resolve()
    const count = state.backupCreated.mock.calls.length
    finish()
    await ready()
    expect(count).toBe(1)
  })

  it('reopens repeatedly with one vault, session hub, IPC set and theme listener', async () => {
    await import('../src/main/index')
    let win = await ready()
    const saved = invoke('hosts:save', win, {
      groupId: null, name: 'Saved host', host: 'example.test', port: 22,
      username: 'test', authType: 'password'
    })
    const handlers = new Map(state.handlers)
    for (let index = 0; index < 3; index++) {
      const previous = win
      previous.close()
      expect(state.closeAll).toHaveBeenCalledTimes(index + 1)
      expect(() => nativeTheme.emit('updated')).not.toThrow()
      expect(() => invoke('hosts:list', previous)).toThrow('拒绝的调用方')
      app.emit('activate')
      app.emit('activate')
      win = await ready()
      expect(invoke('hosts:list', win)).toEqual([saved])
      expect(invoke('pty:open', win, 80, 24)).toMatchObject({ id: 'local' })
      expect(() => invoke('hosts:list', previous)).toThrow('拒绝的调用方')
      nativeTheme.emit('updated')
      expect(win.webContents.send).toHaveBeenCalledWith('theme:changed', { theme: 'light' })
      state.send!('pty:data', { data: 'new window' })
      expect(win.webContents.send).toHaveBeenCalledWith('pty:data', { data: 'new window' })
    }
    expect(state.handlers).toEqual(handlers)
    expect(state.backupCreated).toHaveBeenCalledTimes(1)
    expect(state.sessionsCreated).toHaveBeenCalledTimes(1)
    expect(nativeTheme.listenerCount('updated')).toBe(1)
  })
  it('reports remote edits recovered at startup and a recovery that must be retried', async () => {
    state.startupRecovered = [path.join(state.directory, 'recovered', '20261027120000-nginx.conf')]
    state.startupRecoveryFailed = path.join(state.directory, 'watch')
    await import('../src/main/index')
    const win = await ready()
    expect(invoke('app:info', win).dataNotices).toEqual([
      { kind: 'recovered', path: state.startupRecovered[0] },
      { kind: 'recovery-failed', path: state.startupRecoveryFailed }
    ])
  })
})

describe('quitting', () => {
  const quitEvent = () => ({ preventDefault: vi.fn() })

  it('closes every session once before quitting and then lets the quit through', async () => {
    let finish!: () => void
    state.closeAll.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    await import('../src/main/index')
    await ready()
    const first = quitEvent()
    const repeated = quitEvent()
    app.emit('before-quit', first)
    app.emit('before-quit', repeated)
    expect(first.preventDefault).toHaveBeenCalled()
    expect(repeated.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(state.closeAll).toHaveBeenCalledTimes(1))
    expect(app.quit).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1))
    const final = quitEvent()
    app.emit('before-quit', final)
    expect(final.preventDefault).not.toHaveBeenCalled()
  })

  it('requests a single relaunch and exits only after cleanup', async () => {
    let finish!: () => void
    state.closeAll.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    await import('../src/main/index')
    const win = await ready()
    invoke('app:relaunch', win)
    invoke('app:relaunch', win)
    expect(app.relaunch).toHaveBeenCalledOnce()
    expect(app.quit).toHaveBeenCalledOnce()
    app.emit('before-quit', quitEvent())
    await vi.waitFor(() => expect(state.closeAll).toHaveBeenCalledOnce())
    expect(app.exit).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledExactlyOnceWith(0))
  })

  it('quits after five seconds even if a session never finishes closing', async () => {
    await import('../src/main/index')
    await ready()
    vi.useFakeTimers()
    state.closeAll.mockReturnValueOnce(new Promise<void>(() => {}))
    app.emit('before-quit', quitEvent())
    await vi.advanceTimersByTimeAsync(4999)
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('quits immediately when startup has not created any sessions', async () => {
    let finish!: () => void
    state.backupInit.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    await import('../src/main/index')
    await vi.waitFor(() => expect(state.backupInit).toHaveBeenCalledTimes(1))
    const event = quitEvent()
    app.emit('before-quit', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(state.closeAll).not.toHaveBeenCalled()
    finish()
    await ready()
  })
})
