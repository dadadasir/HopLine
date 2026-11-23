import { beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import type { IpcDeps } from '../src/main/ipc'

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn(), on: vi.fn(), remove: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.remove }, webUtils: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true }
}))
import '../src/preload/index'
import { registerIpc, isAppEvent } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi
beforeEach(() => vi.clearAllMocks())

it('forwards the three collection operations and whitelists update events', async () => {
  await bridge.collect.run('host'); await bridge.collect.latest(); await bridge.collect.overview(true)
  expect(mocks.invoke.mock.calls).toEqual([['collect:run', 'host'], ['collect:latest'], ['collect:overview', true]])
  const fn = vi.fn(), stop = bridge.on('collect:updated', fn)
  expect(mocks.on.mock.calls[0][0]).toBe('collect:updated')
  mocks.on.mock.calls[0][1]({}, { host: {} }); expect(fn).toHaveBeenCalledWith({ host: {} })
  stop(); expect(mocks.remove).toHaveBeenCalledTimes(1)
  expect(isAppEvent('collect:updated')).toBe(true)
})
it('guards callers and validates collection inputs before running any operation', () => {
  const win = { isDestroyed: () => false, webContents: {} }
  const collect = { run: vi.fn(), latest: vi.fn(), setOverviewOpen: vi.fn() }
  registerIpc({ getWindow: () => win, collect, shots: false } as unknown as IpcDeps)
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  const valid = { sender: win.webContents }
  for (const channel of ['collect:run', 'collect:latest', 'collect:overview']) expect(() => handler(channel)({ sender: {} }, true)).toThrow('拒绝的调用方')
  expect(() => handler('collect:run')(valid, '')).toThrow('参数不完整')
  expect(() => handler('collect:overview')(valid, 'true')).toThrow('参数不完整')
  expect(collect.run).not.toHaveBeenCalled(); expect(collect.latest).not.toHaveBeenCalled(); expect(collect.setOverviewOpen).not.toHaveBeenCalled()
  handler('collect:run')(valid, 'a'); handler('collect:latest')(valid); handler('collect:overview')(valid, false)
  expect(collect.run).toHaveBeenCalledWith('a'); expect(collect.latest).toHaveBeenCalledOnce(); expect(collect.setOverviewOpen).toHaveBeenCalledWith(false)
})
it('prunes snapshots when a host is deleted or backup data is replaced', async () => {
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }, prune = vi.fn()
  const deps = { getWindow: () => win, collect: { prune }, vault: { deleteHost: vi.fn() }, save: vi.fn(),
    sessions: { closeHost: vi.fn(async () => {}), pool: { invalidate: vi.fn(), invalidateAll: vi.fn() } }, backup: { scheduleAuto: vi.fn(), importFrom: vi.fn(), webdav: vi.fn() }, shots: false }
  registerIpc(deps as unknown as IpcDeps)
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  const event = { sender: win.webContents }
  handler('hosts:delete')(event, 'a')
  await handler('backup:import')(event, '/tmp/backup', null, 'replace')
  await handler('backup:webdav')(event, 'pull', null, 'replace', 'restore-request')
  expect(prune).toHaveBeenCalledTimes(3)
})
