import { beforeEach, expect, it, vi } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import type { HoplineApi } from '../src/shared/api'
const mocks = vi.hoisted(() => ({ handle: vi.fn(), expose: vi.fn(), invoke: vi.fn(), write: vi.fn(), clear: vi.fn(), read: vi.fn(), readText: vi.fn(), prompt: vi.fn(async () => {}), canPrompt: vi.fn(() => false) }))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle, on: vi.fn() }, ipcRenderer: { invoke: mocks.invoke }, contextBridge: { exposeInMainWorld: mocks.expose }, webUtils: {}, BrowserWindow: class {}, clipboard: { write: mocks.write, read: mocks.read, readText: mocks.readText, clear: mocks.clear, writeText: vi.fn() }, ClipboardItem: class { constructor(public data: unknown) {} }, systemPreferences: { canPromptTouchID: mocks.canPrompt, promptTouchID: mocks.prompt }, dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => true } }))
import { registerIpc, type IpcDeps } from '../src/main/ipc'
import '../src/preload/index'
import { CONCEALED_FORMAT, OWNER_FORMAT } from '../src/main/host-secrets'
const api = mocks.expose.mock.calls[0][1] as HoplineApi
const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }, event = { sender: win.webContents }
const handler = (name: string) => mocks.handle.mock.calls.find(([channel]) => channel === name)?.[1]
let vault: Vault, id: string, unlocked: boolean, cleanup: () => Promise<void>
const save = vi.fn()
beforeEach(() => {
  vi.clearAllMocks(); unlocked = true; mocks.canPrompt.mockReturnValue(false)
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  id = vault.saveHost({ groupId: null, name: 'Fixture', host: 'localhost', port: 22, username: 'root', authType: 'password', password: 'fixture-private', privateKey: 'private-key' }).id
  cleanup = registerIpc({ vault, save, onTheme: vi.fn(), getWindow: () => win, backup: { status: () => ({ unlocked }), scheduleAuto: vi.fn() } } as unknown as IpcDeps)
})
it('guards every new channel before reading secrets, and validates fields and payloads', async () => {
  const decrypt = vi.spyOn(vault, 'readHostSecret')
  for (const channel of ['hosts:copySecret', 'hosts:revealSecret', 'hosts:copyConnectionCard', 'app:relaunch']) expect(() => handler(channel)({ sender: {} }, id, 'password')).toThrow('拒绝的调用方')
  await expect(handler('hosts:revealSecret')(event, id, 'privateKey')).rejects.toThrow('字段')
  await expect(handler('hosts:copySecret')(event, id, '__proto__')).rejects.toThrow('字段')
  await expect(handler('hosts:copySecret')(event, id, 'privateKey')).rejects.toThrow('字段')
  expect(handler('hosts:copyConnectionInfo')).toBeUndefined()
  expect(decrypt).not.toHaveBeenCalled()
})
it('copies atomic concealed data without returning plaintext, while list returns flags only', async () => {
  expect(await handler('hosts:copySecret')(event, id, 'password')).toBeUndefined()
  const data = mocks.write.mock.calls[0][0][0].data
  expect(await data['text/plain'].text()).toBe('fixture-private')
  expect(Object.keys(data)).toEqual(['text/plain', CONCEALED_FORMAT, OWNER_FORMAT])
  const list = handler('hosts:list')(event)
  expect(list[0]).toMatchObject({ hasPassword: true, hasPrivateKey: true })
  expect(JSON.stringify(list)).not.toMatch(/fixture-private|private-key|passwordEnc/)
  expect(await handler('hosts:revealSecret')(event, id, 'password')).toBe('fixture-private')
})
it('refuses a locked master-password library even when OS encryption exists', async () => {
  const data = vault.snapshot(); data.settings.backup.kdf = { opslimit: 1, memlimit: 8192, salt: 'fixture' }; data.settings.backup.verifier = 'fixture'; vault.replace(data); unlocked = false
  await expect(handler('hosts:copySecret')(event, id, 'password')).rejects.toThrow('锁定')
  await expect(handler('hosts:revealSecret')(event, id, 'password')).rejects.toThrow('锁定')
  expect(mocks.write).not.toHaveBeenCalled()
})
it('rejects failed Touch ID without passing secret bytes to the clipboard', async () => {
  if (process.platform !== 'darwin') return
  mocks.canPrompt.mockReturnValue(true); mocks.prompt.mockRejectedValueOnce(new Error('cancelled'))
  await expect(handler('hosts:copySecret')(event, id, 'password')).rejects.toThrow('身份验证未通过')
  expect(mocks.write).not.toHaveBeenCalled()
})
it('exposes narrowly named preload calls with their exact arguments', async () => {
  await api.hosts.copyConnectionCard('host'); await api.hosts.copySecret('host', 'password'); await api.hosts.revealSecret('host', { jumpIndex: 0, field: 'passphrase' }); await api.app.relaunch()
  expect(mocks.invoke.mock.calls).toEqual([['hosts:copyConnectionCard', 'host'], ['hosts:copySecret', 'host', 'password'], ['hosts:revealSecret', 'host', { jumpIndex: 0, field: 'passphrase' }], ['app:relaunch']])
})

it('does not downgrade verification or persist any settings until authentication succeeds', async () => {
  if (process.platform !== 'darwin') return
  mocks.canPrompt.mockReturnValue(true)
  mocks.prompt.mockRejectedValueOnce(new Error('cancelled'))
  const before = vault.snapshot()
  await expect(handler('settings:update')(event, { verifySecrets: false, language: 'en' })).rejects.toThrow('身份验证未通过')
  expect(vault.snapshot()).toEqual(before); expect(save).not.toHaveBeenCalled()
  expect(await handler('settings:update')(event, { verifySecrets: false })).toMatchObject({ verifySecrets: false })
  expect(save).toHaveBeenCalledOnce(); expect(mocks.prompt).toHaveBeenCalledTimes(2)
  expect(handler('settings:update')(event, { verifySecrets: true })).toMatchObject({ verifySecrets: true })
  expect(mocks.prompt).toHaveBeenCalledTimes(2)
})
it('rejects a downgrade while locked or after the calling window changed', async () => {
  const data = vault.snapshot(); data.settings.backup.kdf = { opslimit: 1, memlimit: 8192, salt: 'fixture' }; data.settings.backup.verifier = 'fixture'; vault.replace(data); unlocked = false
  await expect(handler('settings:update')(event, { verifySecrets: false })).rejects.toThrow('锁定')
  expect(vault.settingsPublic(false).verifySecrets).toBe(true); expect(save).not.toHaveBeenCalled()
  expect(() => handler('settings:update')({ sender: {} }, { verifySecrets: false })).toThrow('拒绝的调用方')
})
it('registerIpc cleanup disposes the owned concealed connection card', async () => {
  expect(await handler('hosts:copyConnectionCard')(event, id)).toBeUndefined()
  const data = mocks.write.mock.calls[0][0][0].data
  mocks.read.mockResolvedValue([{ types: [OWNER_FORMAT], getType: async () => data[OWNER_FORMAT] }])
  expect(await data['text/plain'].text()).toBe('名称：Fixture\nIP：localhost\n端口：22\n用户名：root\n密码：fixture-private')
  expect(Object.keys(data)).toEqual(['text/plain', CONCEALED_FORMAT, OWNER_FORMAT])
  mocks.readText.mockResolvedValue(await data['text/plain'].text())
  await cleanup()
  expect(mocks.clear).toHaveBeenCalledOnce()
  await expect(handler('hosts:revealSecret')(event, id, 'password')).rejects.toThrow('退出')
})

it('holds all settings changes while identity verification is pending', async () => {
  if (process.platform !== 'darwin') return
  mocks.canPrompt.mockReturnValue(true)
  let approve!: () => void
  mocks.prompt.mockImplementationOnce(() => new Promise<void>(resolve => { approve = resolve }))
  const pending = handler('settings:update')(event, { verifySecrets: false, language: 'en' })
  expect(vault.settingsPublic(true)).toMatchObject({ verifySecrets: true, language: 'zh' })
  expect(save).not.toHaveBeenCalled()
  approve(); await pending
  expect(vault.settingsPublic(true)).toMatchObject({ verifySecrets: false, language: 'en' })
  expect(save).toHaveBeenCalledOnce()
})
