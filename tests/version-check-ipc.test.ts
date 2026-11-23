import { beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
const mock = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mock.expose }, ipcRenderer: { invoke: mock.invoke }, webUtils: {},
  BrowserWindow: class {}, dialog: {}, shell: {}, clipboard: {},
  ipcMain: { handle: mock.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true }
}))
import '../src/preload/index'
import { registerIpc, type IpcDeps } from '../src/main/ipc'
const bridge = mock.expose.mock.calls[0][1] as HoplineApi
beforeEach(() => vi.clearAllMocks())

it('exposes the version-change invocation through preload', async () => {
  await bridge.app.versionChange()
  expect(mock.invoke).toHaveBeenCalledExactlyOnceWith('app:versionChange')
})

it('guards the caller before consuming the one-time notification', () => {
  const win = { isDestroyed: () => false, webContents: {} }
  const versionChange = { previous: '0.2.0', current: '0.3.0' }
  registerIpc({ getWindow: () => win, versionChange } as unknown as IpcDeps)
  const handler = mock.handle.mock.calls.find(([name]) => name === 'app:versionChange')![1]
  expect(() => handler({ sender: {} })).toThrow('拒绝的调用方')
  expect(handler({ sender: win.webContents })).toEqual(versionChange)
  expect(handler({ sender: win.webContents })).toBeNull()
})
