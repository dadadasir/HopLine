import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), expose: vi.fn(), invoke: vi.fn(async () => undefined) }))
vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle, on: vi.fn() }, ipcRenderer: { invoke: mocks.invoke },
  contextBridge: { exposeInMainWorld: mocks.expose }, webUtils: {},
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true }
}))
import '../src/preload/index'
import { registerIpc, type IpcDeps } from '../src/main/ipc'
const api = mocks.expose.mock.calls[0][1] as HoplineApi
let directory: string
let vault: Vault
const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
const save = vi.fn(), scheduleAuto = vi.fn()
const handler = (suffix: string) => mocks.handle.mock.calls.find(([name]) => name === `hosts:importSshConfig:${suffix}`)![1]
const event = { sender: win.webContents }

beforeEach(() => {
  vi.clearAllMocks()
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-import-ipc-'))
  fs.mkdirSync(path.join(directory, '.ssh', 'conf'), { recursive: true })
  vi.spyOn(os, 'homedir').mockReturnValue(directory)
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  registerIpc({ vault, save, getWindow: () => win, backup: { scheduleAuto } } as unknown as IpcDeps)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }) })

it('previews a real native glob Include and marks an existing endpoint without saving', () => {
  fs.writeFileSync(path.join(directory, '.ssh/config'), 'Include conf/*.conf')
  fs.writeFileSync(path.join(directory, '.ssh/conf/host.conf'), 'Host imported\nHostName same.test\nUser hop')
  const existing = vault.saveHost({ groupId: null, name: 'old', host: 'same.test', username: 'hop', port: 22, authType: 'agent' })
  const result = handler('preview')(event)
  expect(result.hosts).toHaveLength(1)
  expect(result.hosts[0]).toMatchObject({ name: 'imported', duplicateOf: existing.id })
  expect(save).not.toHaveBeenCalled()
  expect(vault.listHosts()).toHaveLength(1)
})

it('returns an empty preview for a missing config and rejects a foreign renderer before accessing data', () => {
  expect(handler('preview')(event)).toEqual({ hosts: [], warnings: [] })
  expect(() => handler('preview')({ sender: {} })).toThrow('拒绝的调用方')
  expect(() => handler('apply')({ sender: {} }, [], null)).toThrow('拒绝的调用方')
})

it('saves selected hosts into the selected group, counts failures, and never overwrites an incoming id', () => {
  const input = { groupId: null, name: 'host', host: 'target.test', port: 22, username: 'hop', authType: 'agent' as const }
  const old = vault.saveHost(input)
  const group = vault.saveGroup({ name: 'Imported' })
  const result = handler('apply')(event, [{ ...input, id: old.id, name: 'new' }, { ...input, username: '' }], group.id)
  expect(result).toEqual({ success: 1, failed: 1 })
  expect(vault.listHosts()).toHaveLength(2)
  expect(vault.getHost(old.id)).toMatchObject({ name: 'host', groupId: null })
  expect(vault.listHosts().find((host) => host.name === 'new')).toMatchObject({ groupId: group.id })
  expect(save).toHaveBeenCalledOnce()
  expect(scheduleAuto).toHaveBeenCalledOnce()
  expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith('store:changed')
})

it('does not persist an empty or wholly invalid selection and validates the payload', () => {
  expect(handler('apply')(event, [], null)).toEqual({ success: 0, failed: 0 })
  expect(handler('apply')(event, [null], null)).toEqual({ success: 0, failed: 1 })
  expect(() => handler('apply')(event, null, null)).toThrow('导入参数不正确')
  expect(save).not.toHaveBeenCalled()
})

it('exposes both import calls through the preload with their arguments', async () => {
  await api.hosts.importSshConfig.preview()
  await api.hosts.importSshConfig.apply([], 'group')
  expect(mocks.invoke.mock.calls).toEqual([
    ['hosts:importSshConfig:preview'], ['hosts:importSshConfig:apply', [], 'group']
  ])
})
