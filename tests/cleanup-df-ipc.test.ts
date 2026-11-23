import { beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import type { IpcDeps } from '../src/main/ipc'

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn(), on: vi.fn(), remove: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.remove }, webUtils: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true }
}))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi
beforeEach(() => vi.clearAllMocks())

it('bridges only the target host and read-only mount operand', async () => {
  await bridge.cleanup.disk('host', '/data files')
  expect(mocks.invoke).toHaveBeenCalledWith('cleanup:disk', 'host', '/data files')
})

it('guards the caller, validates host existence and argument types before invoking disk measurement', () => {
  const win = { isDestroyed: () => false, webContents: {} }, runbook = { disk: vi.fn() }
  const vault = { getHost: vi.fn((id: string) => id === 'host' ? { id } : undefined) }
  registerIpc({ getWindow: () => win, runbook, vault, shots: false } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'cleanup:disk')![1], event = { sender: win.webContents }
  expect(() => handler({ sender: {} }, 'host', '/')).toThrow('拒绝')
  for (const host of [null, '', 1, {}, []]) expect(() => handler(event, host, '/')).toThrow('参数')
  expect(() => handler(event, 'missing', '/')).toThrow('主机不存在')
  for (const mount of [null, '', 1, {}, []]) expect(() => handler(event, 'host', mount)).toThrow('参数')
  expect(runbook.disk).not.toHaveBeenCalled()
  handler(event, 'host', '/data files')
  expect(runbook.disk).toHaveBeenCalledWith('host', '/data files')
})
