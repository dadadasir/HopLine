import { beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import { hopEvents } from '../src/shared/api'
import { Vault, emptyStore, MemorySecretCodec } from '../src/core/vault'
import { forwardActions } from '../src/renderer/src/logic/palette'
import { translate } from '../src/renderer/src/i18n'

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn(), on: vi.fn(), off: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.off },
  webUtils: {}, BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true }
}))
vi.mock('../src/main/snippets', () => ({ listSnippets: vi.fn(), saveSnippet: vi.fn(), deleteSnippet: vi.fn() }))
import '../src/preload/index'
import { registerIpc, isAppEvent, type IpcDeps } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0]![1] as HoplineApi
beforeEach(() => { vi.clearAllMocks() })

it('preload routes all forwarding commands and allows status subscriptions with cleanup', async () => {
  await bridge.forwards.list(); await bridge.forwards.start('host', 'rule'); await bridge.forwards.stop('host', 'rule')
  expect(mocks.invoke.mock.calls).toEqual([['forwards:list'], ['forwards:start', 'host', 'rule'], ['forwards:stop', 'host', 'rule']])
  const listener = vi.fn(), off = bridge.on('forwards:status', listener)
  const wrapped = mocks.on.mock.calls[0]![1]; wrapped({}, [{ state: 'running' }])
  expect(listener).toHaveBeenCalledWith([{ state: 'running' }]); off()
  expect(mocks.off).toHaveBeenCalledWith('forwards:status', wrapped)
  expect(hopEvents).toContain('forwards:status'); expect(isAppEvent('forwards:status')).toBe(true)
})

it.each(['list', 'start', 'stop'] as const)('guards forwards:%s and validates IDs before accessing the manager', async (operation) => {
  const win = { isDestroyed: () => false, webContents: {} }
  const forwards = { statuses: vi.fn(), start: vi.fn(), stop: vi.fn() }
  registerIpc({ getWindow: () => win, forwards, shots: false } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([name]) => name === `forwards:${operation}`)![1]
  expect(() => handler({ sender: {} }, 'host', 'rule')).toThrow('拒绝的调用方')
  expect(Object.values(forwards).every((method) => method.mock.calls.length === 0)).toBe(true)
  if (operation !== 'list') expect(() => handler({ sender: win.webContents }, '', 'rule')).toThrow('参数不完整')
  await handler({ sender: win.webContents }, 'host', 'rule')
  expect(forwards[operation === 'list' ? 'statuses' : operation].mock.calls).toEqual(operation === 'list' ? [[]] : [['host', 'rule']])
})

it('saving/deleting/importing host data reconciles forwarding rules', async () => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const forwards = { reconcile: vi.fn(async () => {}) }
  registerIpc({ vault, getWindow: () => win, forwards, save: vi.fn(), shots: false,
    backup: { scheduleAuto: vi.fn(), importFrom: vi.fn(async () => {}), webdav: vi.fn(async () => {}) },
    sessions: { closeHost: vi.fn(async () => {}), pool: { invalidate: vi.fn(), invalidateAll: vi.fn() } }
  } as unknown as IpcDeps)
  const call = (channel: string, ...args: unknown[]) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]({ sender: win.webContents }, ...args)
  const host = await call('hosts:save', { name: 'host', host: 'localhost', port: 22, username: 'hop', authType: 'password', groupId: null })
  await call('hosts:delete', host.id); await call('backup:import', '/tmp/test', null, 'replace'); await call('backup:webdav', 'pull', null, 'merge', 'restore-request')
  expect(forwards.reconcile).toHaveBeenCalledTimes(4)
})

it.each(['zh', 'en'] as const)('palette shows one start/stop action per rule with %s labels and exact IDs', (locale) => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const host = vault.saveHost({ name: 'host', host: 'localhost', port: 22, username: 'hop', authType: 'password', groupId: null,
    forwards: [{ id: 'rule', type: 'local', bindHost: '127.0.0.1', bindPort: 8080, targetHost: 'localhost', targetPort: 80, autoStart: false }] })
  const toggle = vi.fn(async () => {}), t = (key: string) => translate(locale, key)
  for (const running of [false, true]) {
    const actions = forwardActions([host], [{ hostId: host.id, ruleId: 'rule', state: running ? 'running' : 'error', connections: 0 }], t, toggle)
    expect(actions).toHaveLength(1); expect(actions[0]!.label).toBe(`${t(running ? 'forward.stop' : 'forward.start')}：host L 127.0.0.1:8080 → localhost:80`)
    actions[0]!.run(); expect(toggle).toHaveBeenLastCalledWith(host.id, 'rule', running)
  }
})
