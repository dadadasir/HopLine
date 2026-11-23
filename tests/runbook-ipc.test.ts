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
it('forwards runbook and oplog calls and whitelists correlated progress events', async () => {
  await bridge.runbook.plan('host', 'timezone', { TZ: 'UTC' })
  await bridge.runbook.run('host', 'plan', ['timezone'], 'password')
  await bridge.runbook.cancel('host'); await bridge.oplog.list('host')
  expect(mocks.invoke.mock.calls).toEqual([
    ['runbook:plan', 'host', 'timezone', { TZ: 'UTC' }], ['runbook:run', 'host', 'plan', ['timezone'], 'password'],
    ['runbook:cancel', 'host'], ['oplog:list', 'host']
  ])
  const listener = vi.fn(), off = bridge.on('runbook:progress', listener)
  mocks.on.mock.calls[0][1]({}, { hostId: 'host', planId: 'plan' })
  expect(listener).toHaveBeenCalledWith({ hostId: 'host', planId: 'plan' })
  off(); expect(mocks.remove).toHaveBeenCalledOnce(); expect(isAppEvent('runbook:progress')).toBe(true)
})
it('guards every channel and validates payload shapes before invoking the service', () => {
  const win = { isDestroyed: () => false, webContents: {} }
  const runbook = { plan: vi.fn(), run: vi.fn(), cancel: vi.fn(), log: { list: vi.fn() } }
  registerIpc({ getWindow: () => win, runbook, shots: false } as unknown as IpcDeps)
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  const event = { sender: win.webContents }
  for (const channel of ['runbook:plan', 'runbook:run', 'runbook:cancel', 'oplog:list']) expect(() => handler(channel)({ sender: {} })).toThrow('拒绝')
  for (const params of [null, [], 'x', { TZ: 1 }]) expect(() => handler('runbook:plan')(event, 'host', 'timezone', params)).toThrow('参数')
  for (const selected of [null, 'a', [1]]) expect(() => handler('runbook:run')(event, 'host', 'plan', selected)).toThrow('参数')
  expect(() => handler('runbook:run')(event, 'host', 'plan', [], 12)).toThrow('参数')
  expect(() => handler('oplog:list')(event, '')).toThrow('参数')
  expect(runbook.plan).not.toHaveBeenCalled(); expect(runbook.run).not.toHaveBeenCalled()
  handler('runbook:plan')(event, 'host', 'timezone', { TZ: 'UTC' })
  handler('runbook:run')(event, 'host', 'plan', ['timezone'], 'pw')
  handler('runbook:cancel')(event, 'host'); handler('oplog:list')(event, 'host')
  expect(runbook.plan).toHaveBeenCalledWith('host', 'timezone', { TZ: 'UTC' })
  expect(runbook.run).toHaveBeenCalledWith('host', 'plan', ['timezone'], 'pw')
  expect(runbook.cancel).toHaveBeenCalledWith('host'); expect(runbook.log.list).toHaveBeenCalledWith('host')
})
it('removes logs on host deletion and prunes hosts removed by backup import', async () => {
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }, runbook = { deleteHost: vi.fn(), prune: vi.fn() }
  registerIpc({ getWindow: () => win, runbook, vault: { deleteHost: vi.fn() }, save: vi.fn(),
    sessions: { closeHost: vi.fn(async () => {}), pool: { invalidate: vi.fn(), invalidateAll: vi.fn() } }, backup: { scheduleAuto: vi.fn(), importFrom: vi.fn(), webdav: vi.fn() }, shots: false } as unknown as IpcDeps)
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  const event = { sender: win.webContents }
  handler('hosts:delete')(event, 'host')
  await handler('backup:import')(event, '/tmp/file', null, 'replace')
  await handler('backup:webdav')(event, 'pull', null, 'replace', 'restore-request')
  expect(runbook.deleteHost).toHaveBeenCalledWith('host'); expect(runbook.prune).toHaveBeenCalledTimes(3)
})

it('bridges optional planning credentials and permission probing without changing legacy calls', async () => {
  await bridge.cleanup.sudo('host')
  await bridge.runbook.plan('host', 'cleanup', {}, 'private-password')
  expect(mocks.invoke.mock.calls).toEqual([['cleanup:sudo', 'host'], ['runbook:plan', 'host', 'cleanup', {}, 'private-password']])
  const win = { isDestroyed: () => false, webContents: {} }, runbook = { sudo: vi.fn(), plan: vi.fn() }
  registerIpc({ getWindow: () => win, runbook, shots: false } as unknown as IpcDeps)
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1], event = { sender: win.webContents }
  expect(() => handler('cleanup:sudo')({ sender: {} }, 'host')).toThrow('拒绝')
  expect(() => handler('cleanup:sudo')(event, '')).toThrow('参数')
  for (const password of [1, {}, null, []]) expect(() => handler('runbook:plan')(event, 'host', 'cleanup', {}, password)).toThrow('参数')
  expect(runbook.plan).not.toHaveBeenCalled()
  handler('cleanup:sudo')(event, 'host')
  handler('runbook:plan')(event, 'host', 'cleanup', {}, 'private-password')
  expect(runbook.sudo).toHaveBeenCalledWith('host')
  expect(runbook.plan).toHaveBeenCalledWith('host', 'cleanup', {}, {}, 'private-password')
})

it('bridges scoped cancellation while validating the optional plan id', async () => {
  await bridge.runbook.cancel('host', 'owned-plan')
  expect(mocks.invoke).toHaveBeenCalledWith('runbook:cancel', 'host', 'owned-plan')
  const win = { isDestroyed: () => false, webContents: {} }, runbook = { cancel: vi.fn() }
  registerIpc({ getWindow: () => win, runbook, shots: false } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([name]) => name === 'runbook:cancel')![1], event = { sender: win.webContents }
  for (const planId of [null, 1, {}, '']) expect(() => handler(event, 'host', planId)).toThrow('参数')
  expect(runbook.cancel).not.toHaveBeenCalled()
  handler(event, 'host', 'owned-plan')
  expect(runbook.cancel).toHaveBeenCalledWith('host', 'owned-plan')
})

it('guards and bridges read-only cleanup diagnosis without accepting non-string credentials', async () => {
  await bridge.cleanup.diagnose('host', 'ephemeral')
  expect(mocks.invoke).toHaveBeenCalledWith('cleanup:diagnose', 'host', 'ephemeral')
  const win = { isDestroyed: () => false, webContents: {} }, runbook = { diagnose: vi.fn() }
  registerIpc({ getWindow: () => win, runbook, shots: false } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([name]) => name === 'cleanup:diagnose')![1]
  expect(() => handler({ sender: {} }, 'host')).toThrow('拒绝')
  for (const value of [null, {}, [], 1]) expect(() => handler({ sender: win.webContents }, 'host', value)).toThrow('参数')
  handler({ sender: win.webContents }, 'host', 'ephemeral')
  expect(runbook.diagnose).toHaveBeenCalledWith('host', 'ephemeral')
})

it('bridges read request ids, rejects malformed ids and limits planning request ids to cleanup', async () => {
  await bridge.cleanup.du('host', '/', 'du-request')
  await bridge.cleanup.diagnose('host', 'pw', 'check-request')
  await bridge.runbook.plan('host', 'cleanup', {}, 'pw', 'check-request')
  expect(mocks.invoke.mock.calls).toEqual([
    ['cleanup:du', 'host', '/', 'du-request'], ['cleanup:diagnose', 'host', 'pw', 'check-request'], ['runbook:plan', 'host', 'cleanup', {}, 'pw', 'check-request']
  ])
  const win = { isDestroyed: () => false, webContents: {} }, runbook = { plan: vi.fn(), diagnose: vi.fn() }
  registerIpc({ getWindow: () => win, runbook, shots: false } as unknown as IpcDeps)
  const handler = (name: string) => mocks.handle.mock.calls.find(([channel]) => channel === name)![1], event = { sender: win.webContents }
  for (const request of [null, 3, {}, '']) expect(() => handler('runbook:plan')(event, 'host', 'cleanup', {}, '', request)).toThrow('参数')
  expect(() => handler('runbook:plan')(event, 'host', 'timezone', {}, '', 'request')).toThrow('参数')
  handler('runbook:plan')(event, 'host', 'cleanup', {}, 'pw', 'request')
  expect(runbook.plan).toHaveBeenCalledWith('host', 'cleanup', {}, {}, 'pw', 'request')
})
