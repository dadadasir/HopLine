import { beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import type { IpcDeps } from '../src/main/ipc'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() }, webUtils: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true }
}))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi
beforeEach(() => vi.clearAllMocks())

it('exposes host-owned file access and all-job restoration through preload', async () => {
  await bridge.sftp.openHost('host')
  await bridge.sftp.jobs()
  await bridge.sftp.jobs('files')
  expect(mocks.invoke.mock.calls).toEqual([
    ['sftp:openHost', 'host'], ['sftp:jobs', undefined], ['sftp:jobs', 'files']
  ])
})

it('guards file context creation and validates optional job filters', async () => {
  const win = { isDestroyed: () => false, webContents: {} }
  const sessions = { openHostFiles: vi.fn(async () => 'files'), jobsFor: vi.fn(() => []) }
  registerIpc({ getWindow: () => win, sessions, shots: false } as unknown as IpcDeps)
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  const event = { sender: win.webContents }
  expect(() => handler('sftp:openHost')({ sender: {} }, 'host')).toThrow('拒绝的调用方')
  expect(() => handler('sftp:openHost')(event, '')).toThrow('参数不完整')
  expect(() => handler('sftp:jobs')(event, 12)).toThrow('参数不完整')
  expect(sessions.openHostFiles).not.toHaveBeenCalled()
  expect(await handler('sftp:openHost')(event, 'host')).toBe('files')
  expect(sessions.openHostFiles).toHaveBeenCalledExactlyOnceWith('host')
  await handler('sftp:jobs')(event)
  expect(sessions.jobsFor).toHaveBeenCalledExactlyOnceWith(undefined)
})

it('closes host-owned resources when deleting a host', async () => {
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const sessions = { closeHost: vi.fn(async () => {}), pool: { invalidate: vi.fn() } }
  registerIpc({ getWindow: () => win, sessions, vault: { deleteHost: vi.fn() },
    save: vi.fn(), backup: { scheduleAuto: vi.fn() }, shots: false } as unknown as IpcDeps)
  const remove = mocks.handle.mock.calls.find(([name]) => name === 'hosts:delete')![1]
  await remove({ sender: win.webContents }, 'host')
  expect(sessions.pool.invalidate).toHaveBeenCalledExactlyOnceWith('host')
  expect(sessions.closeHost).toHaveBeenCalledExactlyOnceWith('host')
})

it('returns a committed host despite cache cleanup failures and still broadcasts the catalog', () => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const sessions = { pool: { invalidate: vi.fn() } }
  const save = vi.fn()
  const backup = { scheduleAuto: vi.fn() }
  registerIpc({ getWindow: () => win, sessions, vault, save, backup, shots: false,
    collect: { prune: () => { throw new Error('cache disk failure') } } } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([name]) => name === 'hosts:save')![1]
  const saved = handler({ sender: win.webContents }, { groupId: null, newGroupName: 'New group', name: 'server',
    host: 'example.test', port: 22, username: 'test', authType: 'agent' })
  expect(saved.id).toBe(vault.listHosts()[0]?.id)
  expect(vault.listGroups()).toHaveLength(1)
  expect(save).toHaveBeenCalledTimes(1)
  expect(backup.scheduleAuto).toHaveBeenCalledTimes(1)
  expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith('store:changed')
  expect(sessions.pool.invalidate).toHaveBeenCalledExactlyOnceWith(saved.id)
})

it('rejects a failed primary save without publishing or leaving a host or group', () => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const sessions = { pool: { invalidate: vi.fn() } }
  const backup = { scheduleAuto: vi.fn() }
  registerIpc({ getWindow: () => win, sessions, vault, backup, shots: false,
    save: () => { throw new Error('store disk failure') } } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([name]) => name === 'hosts:save')![1]
  expect(() => handler({ sender: win.webContents }, { groupId: null, newGroupName: 'New group', name: 'server',
    host: 'example.test', port: 22, username: 'test', authType: 'agent' })).toThrow('store disk failure')
  expect(vault.listHosts()).toEqual([])
  expect(vault.listGroups()).toEqual([])
  expect(backup.scheduleAuto).not.toHaveBeenCalled()
  expect(win.webContents.send).not.toHaveBeenCalled()
  expect(sessions.pool.invalidate).not.toHaveBeenCalled()
})
