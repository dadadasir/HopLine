import { beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import type { IpcDeps } from '../src/main/ipc'
const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke }, webUtils: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false } }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi
beforeEach(() => vi.clearAllMocks())

it('bridges password rotation, checks callers and argument types, and does not save twice', async () => {
  await bridge.backup.changePassword('old-password', 'new-password', true)
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('backup:changePassword', 'old-password', 'new-password', true)
  const status = { hasPassword: true, unlocked: true, rememberUnlock: true }
  const changePassword = vi.fn().mockResolvedValue(status), save = vi.fn()
  const win = { isDestroyed: () => false, webContents: {} }
  registerIpc({ getWindow: () => win, backup: { changePassword }, save } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'backup:changePassword')![1]
  const event = { sender: win.webContents }
  await expect(handler({ sender: {} }, 'old-password', 'new-password', true)).rejects.toThrow('拒绝')
  await expect(handler(event, 123, 'new-password', true)).rejects.toThrow()
  await expect(handler(event, 'old-password', {}, true)).rejects.toThrow()
  expect(changePassword).not.toHaveBeenCalled()
  expect(await handler(event, 'old-password', 'new-password', true)).toEqual(status)
  expect(changePassword).toHaveBeenCalledExactlyOnceWith('old-password', 'new-password', true)
  expect(save).not.toHaveBeenCalled()
})

it('does not turn a committed password setup into a failure by saving a second time', async () => {
  const status = { hasPassword: true, unlocked: true, rememberUnlock: false }
  const save = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('第二次保存失败') })
  const setPassword = vi.fn(async () => { save(); return status })
  const win = { isDestroyed: () => false, webContents: {} }
  registerIpc({ getWindow: () => win, backup: { setPassword }, save } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'backup:setPassword')![1]
  await expect(handler({ sender: win.webContents }, 'test-password', false)).resolves.toEqual(status)
  expect(setPassword).toHaveBeenCalledExactlyOnceWith('test-password', false)
  expect(save).toHaveBeenCalledTimes(1)
})
