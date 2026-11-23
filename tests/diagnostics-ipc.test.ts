import { beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import { hopEvents } from '../src/shared/api'
import { diagnosticsAction, paletteItems } from '../src/renderer/src/logic/palette'
import { translate } from '../src/renderer/src/i18n'
const mock = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), send: vi.fn(), on: vi.fn(), off: vi.fn(), handle: vi.fn(), mainOn: vi.fn() }))
vi.mock('electron', () => ({
  app: { setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {} },
  contextBridge: { exposeInMainWorld: mock.expose }, ipcRenderer: { invoke: mock.invoke, send: mock.send, on: mock.on, removeListener: mock.off }, webUtils: {},
  BrowserWindow: class {}, dialog: {}, Menu: {}, nativeTheme: {}, session: {}, shell: {}, clipboard: {},
  ipcMain: { handle: mock.handle, on: mock.mainOn }, safeStorage: { isEncryptionAvailable: () => true }
}))
import '../src/preload/index'
import { isAppEvent, registerIpc, type IpcDeps } from '../src/main/ipc'
import { menuTemplate } from '../src/main/index'
const bridge = mock.expose.mock.calls[0][1] as HoplineApi
beforeEach(() => vi.clearAllMocks())
it('routes preload diagnostics and heartbeat messages and removes ping subscriptions', async () => {
  await bridge.diagnostics.preview(); await bridge.diagnostics.save('reviewed'); await bridge.watchdog.sessions(); bridge.watchdog.pong(42)
  expect(mock.invoke.mock.calls).toEqual([['diagnostics:preview'], ['diagnostics:save', 'reviewed'], ['watchdog:sessions']])
  expect(mock.send).toHaveBeenCalledWith('watchdog:pong', 42)
  const listener = vi.fn(), off = bridge.on('watchdog:ping', listener)
  const wrapped = mock.on.mock.calls[0][1]; wrapped({}, 42); expect(listener).toHaveBeenCalledWith(42)
  off(); expect(mock.off).toHaveBeenCalledWith('watchdog:ping', wrapped)
  expect(hopEvents).toContain('watchdog:ping'); expect(isAppEvent('watchdog:ping')).toBe(true)
})
it('guards every new handler and returns existing sessions without creating connections', () => {
  const win = { isDestroyed: () => false, webContents: {} }, pong = vi.fn()
  const sessions = { list: vi.fn(() => [{ id: 'existing', kind: 'ssh' }]) }
  registerIpc({ getWindow: () => win, sessions, watchdogPong: pong } as unknown as IpcDeps)
  for (const channel of ['diagnostics:preview', 'diagnostics:save', 'watchdog:sessions']) {
    const handler = mock.handle.mock.calls.find(([name]) => name === channel)![1]
    expect(() => handler({ sender: {} })).toThrow('拒绝的调用方')
  }
  const list = mock.handle.mock.calls.find(([name]) => name === 'watchdog:sessions')![1]
  expect(list({ sender: win.webContents })).toEqual([{ id: 'existing', kind: 'ssh' }])
  const handlePong = mock.mainOn.mock.calls.find(([name]) => name === 'watchdog:pong')![1]
  handlePong({ sender: {} }, 1); handlePong({ sender: win.webContents }, '1'); expect(pong).not.toHaveBeenCalled()
  handlePong({ sender: win.webContents }, 2); expect(pong).toHaveBeenCalledWith(2)
})
it.each(['zh', 'en'] as const)('offers localized diagnostics in Help and the palette (%s)', (locale) => {
  const send = vi.fn(), template = menuTemplate(locale, 'darwin', true, send)
  const help = template.find((item) => item.label === (locale === 'zh' ? '帮助' : 'Help'))!
  const item = (help.submenu as Electron.MenuItemConstructorOptions[])[0]
  expect(item.label).toBe(locale === 'zh' ? '导出诊断包…' : 'Export diagnostics…')
  item.click!(null as never, null as never, null as never); expect(send).toHaveBeenCalledWith('diagnostics')
  const run = vi.fn(), action = diagnosticsAction(translate(locale, 'diagnostics.title'), run)
  expect(paletteItems([], [action], 'diagnostics')).toHaveLength(1)
  action.run(); expect(run).toHaveBeenCalledOnce()
})
