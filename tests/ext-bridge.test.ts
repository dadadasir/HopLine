import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import { hopEvents } from '../src/shared/api'
import rendererFixture from './fixtures/pro-ext/renderer'

const mocks = vi.hoisted(() => ({
  expose: vi.fn(), invoke: vi.fn(async () => 'pong'), on: vi.fn(), removeListener: vi.fn(),
  handle: vi.fn(), ipcOn: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
  webUtils: {}, BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {},
  ipcMain: { handle: mocks.handle, on: mocks.ipcOn },
  safeStorage: { isEncryptionAvailable: () => true }
}))
import '../src/preload/index'
import { isAppEvent, registerIpc, type IpcDeps } from '../src/main/ipc'
const api = mocks.expose.mock.calls[0][1] as HoplineApi

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('extension bridge', () => {
  it('only invokes pro channels and forwards arguments', async () => {
    await expect(api.pro.invoke('ping', 1, { key: 'value' })).resolves.toBe('pong')
    await api.pro.invoke('pro:ping')
    expect(mocks.invoke.mock.calls).toEqual([['pro:ping', 1, { key: 'value' }], ['pro:ping']])
    for (const name of ['', 'hosts:list', 'app:info', 'pro:', 'pro:hosts:list', null]) {
      expect(() => api.pro.invoke(name as string)).toThrow()
    }
    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('allows pro:event in both whitelists and removes exactly its listener', () => {
    expect(hopEvents).toContain('pro:event')
    expect(isAppEvent('pro:event')).toBe(true)
    const listener = vi.fn()
    const unsubscribe = api.pro.on(listener)
    const [channel, wrapped] = mocks.on.mock.calls[0]
    expect(channel).toBe('pro:event')
    wrapped({ sender: 'must not cross the bridge' }, { type: 'ready', payload: 1 })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: 'ready', payload: 1 })
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledExactlyOnceWith('pro:event', wrapped)
    expect(() => api.on('pro:other' as never, listener)).toThrow('未知事件')
  })

  it('executes the JSX-free renderer fixture through the preload bridge', async () => {
    vi.stubGlobal('window', { hopline: api })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await rendererFixture[0].paletteActions[0].run()
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('pro:ping')
    expect(info).toHaveBeenCalledWith('HOPLINE_PRO_FIXTURE_MARKER', 'pong')
    info.mockRestore()
  })

  it.each(['community', 'pro'])('reports %s in app:info without changing caller validation', (edition) => {
    vi.stubGlobal('__HOPLINE_EDITION__', edition)
    const win = { isDestroyed: () => false, webContents: {} }
    registerIpc({ getWindow: () => win, version: 'test', userData: '/tmp/test', shots: false } as IpcDeps)
    const handler = mocks.handle.mock.calls.find(([name]) => name === 'app:info')![1]
    expect(handler({ sender: win.webContents })).toMatchObject({ edition, name: 'Hopline', version: 'test' })
    expect(() => handler({ sender: {} })).toThrow('拒绝的调用方')
  })
})
