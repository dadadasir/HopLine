import { expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import type { IpcDeps } from '../src/main/ipc'
const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn(), gate: vi.fn(), list: vi.fn(), load: vi.fn(), judge: vi.fn(() => 'trusted') }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke }, webUtils: {}, ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }))
vi.mock('../src/main/init-gates', async (original) => ({ ...await original<typeof import('../src/main/init-gates')>(), loginAsNewUser: mocks.gate, listInitIdentities: mocks.list }))
vi.mock('../src/main/known-hosts-file', () => ({ KnownHostFile: class { load = mocks.load; judge = mocks.judge } }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi
it('exposes only read-only identities and planning; execution still uses the Runbook API', async () => {
  await bridge.init.identities(); await bridge.init.plan('host', { USER: 'admin' }, { type: 'agent' })
  expect(mocks.invoke.mock.calls).toEqual([['init:identities'], ['init:plan', 'host', { USER: 'admin' }, { type: 'agent' }]])
})
it('guards new IPC endpoints, validates inputs, and trusts only saved fingerprints including jumps', async () => {
  const win = { isDestroyed: () => false, webContents: {} }, plan = vi.fn(), vault = {}
  registerIpc({ getWindow: () => win, runbook: { plan }, vault, shots: false, userData: '/test/data' } as unknown as IpcDeps)
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1], event = { sender: win.webContents }
  for (const channel of ['init:identities', 'init:plan']) expect(() => handler(channel)({ sender: {} })).toThrow('拒绝')
  for (const params of [null, [], 'x', { USER: 1 }]) expect(() => handler('init:plan')(event, 'host', params, { type: 'agent' })).toThrow('参数')
  expect(() => handler('init:plan')(event, 'host', {}, { type: 'password' })).toThrow('init.invalidAuth')
  const params = { USER: 'admin' }, auth = { type: 'agent' }
  handler('init:plan')(event, 'host', params, auth)
  expect(plan).toHaveBeenCalledWith('host', 'init', params, { 'login-as-new-user': expect.any(Function) })
  await plan.mock.calls[0][3]['login-as-new-user'](params)
  const verify = mocks.gate.mock.calls[0][4]
  expect(await verify({ host: 'loopback', port: 2222, fingerprint: 'fingerprint' })).toBe(true)
  mocks.judge.mockReturnValueOnce('mismatch')
  expect(await verify({ host: 'jump', port: 22, fingerprint: 'other' })).toBe(false)
  expect(mocks.load).toHaveBeenCalledTimes(2)
})
