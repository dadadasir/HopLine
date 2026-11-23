import { beforeEach, expect, it, vi } from 'vitest'
import { Vault, emptyStore, MemorySecretCodec } from '../src/core/vault'
import { persistentActions } from '../src/renderer/src/logic/palette'
import { translate } from '../src/renderer/src/i18n'
import type { HoplineApi } from '../src/shared/api'
const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn(), on: vi.fn(), off: vi.fn(), confirm: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.off },
  webUtils: {}, BrowserWindow: class {}, clipboard: {}, dialog: { showMessageBox: mocks.confirm }, shell: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true }
}))
import '../src/preload/index'
import { registerIpc, isAppEvent, type IpcDeps } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi
beforeEach(() => vi.clearAllMocks())
it('preload exposes typed persistent operations and notification activation subscriptions', async () => {
  await bridge.persistent.list('host'); await bridge.persistent.kill('host', 'hopline-abc123')
  await bridge.notify('id', { title: 'title', body: 'body' }, null, true)
  await bridge.ssh.connect({ hostId: 'host', cols: 100, rows: 32, persistent: true, tmuxName: 'hopline-abc123' })
  expect(mocks.invoke.mock.calls).toEqual([
    ['persistent:list', 'host'], ['persistent:kill', 'host', 'hopline-abc123'], ['notify:task', 'id', { title: 'title', body: 'body' }, null, true],
    ['ssh:connect', { hostId: 'host', cols: 100, rows: 32, persistent: true, tmuxName: 'hopline-abc123' }]
  ])
  const listener = vi.fn(), off = bridge.on('notify:activate', listener), wrapped = mocks.on.mock.calls[0][1]
  wrapped({}, 'id'); expect(listener).toHaveBeenCalledWith('id'); off()
  expect(mocks.off).toHaveBeenCalledWith('notify:activate', wrapped); expect(isAppEvent('notify:activate')).toBe(true)
})
it('rejects foreign callers, passes options, and requires native confirmation before killing a session', async () => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec()), host = vault.saveHost({ name: 'test', host: 'localhost', port: 22, username: 'hop', authType: 'password', groupId: null })
  const win = { isDestroyed: () => false, webContents: {} }, sessions = { listPersistent: vi.fn(), killPersistent: vi.fn(), connect: vi.fn() }
  registerIpc({ vault, getWindow: () => win, sessions, shots: false } as unknown as IpcDeps)
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  const event = { sender: win.webContents }
  expect(() => handler('persistent:list')({ sender: {} }, host.id)).toThrow('拒绝的调用方')
  await expect(handler('persistent:kill')({ sender: {} }, host.id, 'hopline-abc123')).rejects.toThrow('拒绝的调用方')
  expect(() => handler('notify:task')({ sender: {} }, 'id', { title: 'x', body: '' }, null, true)).toThrow('拒绝的调用方')
  await handler('ssh:connect')(event, { hostId: host.id, cols: 100, rows: 32, persistent: true, tmuxName: 'hopline-abc123' })
  expect(sessions.connect).toHaveBeenCalledWith(host.id, 100, 32, { persistent: true, tmuxName: 'hopline-abc123' })
  mocks.confirm.mockResolvedValue({ response: 0 }); await handler('persistent:kill')(event, host.id, 'hopline-abc123')
  expect(sessions.killPersistent).not.toHaveBeenCalled()
  mocks.confirm.mockResolvedValue({ response: 1 }); await handler('persistent:kill')(event, host.id, 'hopline-abc123')
  expect(sessions.killPersistent).toHaveBeenCalledWith(host.id, 'hopline-abc123')
  expect(mocks.confirm.mock.calls[0][1]).toMatchObject({ defaultId: 0, cancelId: 0 })
})
it.each(['zh', 'en'] as const)('palette persistent commands use exact host/session IDs in %s', (locale) => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec()), host = vault.saveHost({ name: 'test', host: 'localhost', port: 22, username: 'hop', authType: 'password', groupId: null })
  const open = vi.fn(), list = vi.fn(), kill = vi.fn()
  const actions = persistentActions([host], [{ id: 'tab', hostId: host.id, kind: 'ssh', title: 'test', status: 'connected', tmuxName: 'hopline-abc123' }], (key) => translate(locale, key), open, list, kill)
  expect(actions).toHaveLength(3); actions.forEach((action) => action.run())
  expect(open).toHaveBeenCalledWith(host); expect(list).toHaveBeenCalledWith(host); expect(kill).toHaveBeenCalledWith(host.id, 'hopline-abc123')
})
