import { afterEach, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
const mocks = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({
  app: { setName() {}, setAppUserModelId() {}, setPath() {}, requestSingleInstanceLock: () => false, quit() {} },
  BrowserWindow: class {}, dialog: {}, Menu: {}, nativeTheme: {}, session: {}, shell: {}, clipboard: {},
  ipcMain: { handle: mocks.handle, on() {} }, safeStorage: { isEncryptionAvailable: () => true }
}))
import { menuTemplate } from '../src/main/index'
import { registerIpc, type IpcDeps } from '../src/main/ipc'

afterEach(() => vi.clearAllMocks())
function items(template: Electron.MenuItemConstructorOptions[]): Electron.MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])])
}
it.each(['darwin', 'win32', 'linux'])('localizes every menu item including native roles on %s', (platform) => {
  const send = vi.fn()
  for (const locale of ['zh', 'en'] as const) {
    for (const packaged of [true, false]) {
      const flat = items(menuTemplate(locale, platform, packaged, send))
      for (const item of flat.filter((item) => item.type !== 'separator' && item.label !== 'Hopline')) {
        expect(item.label).toBeTruthy()
        expect(/[\u3400-\u9fff]/.test(item.label!)).toBe(locale === 'zh')
      }
      const mod = platform === 'darwin' ? 'CommandOrControl' : 'Ctrl+Shift'
      for (const [key, command] of [['T', 'new-local'], ['N', 'new-host'], ['W', 'close-tab'], ['K', 'palette'], ['F', 'find'], ['B', 'toggle-sidebar']]) {
        const item = flat.find((item) => item.accelerator === `${mod}+${key}`)
        expect(item).toBeDefined()
        item!.click!(null as never, null as never, null as never)
        expect(send).toHaveBeenLastCalledWith(command)
      }
      if (platform !== 'darwin') expect(flat.some(item => /^(CommandOrControl|Ctrl)\+[TNWKFB]$/.test(item.accelerator ?? ''))).toBe(false)
      const updates = flat.find(item => item.label === (locale === 'zh' ? '检查更新…' : 'Check for updates…'))!
      updates.click!(null as never, null as never, null as never)
      expect(send).toHaveBeenLastCalledWith('check-updates')
      expect(flat.some((item) => item.role === 'reload')).toBe(!packaged)
    }
  }
})
it('notifies menu generation of the saved language through settings IPC', () => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const onLanguage = vi.fn((language: 'zh' | 'en') => menuTemplate(language, 'darwin', true, vi.fn()))
  registerIpc({ vault, getWindow: () => win, onLanguage, save() {}, onTheme() {},
    backup: { status: () => ({ unlocked: true }), scheduleAuto() {} }
  } as unknown as IpcDeps)
  const update = mocks.handle.mock.calls.find(([name]) => name === 'settings:update')![1]
  for (const language of ['en', 'zh']) {
    expect(update({ sender: win.webContents }, { language }).language).toBe(language)
    expect(onLanguage).toHaveBeenLastCalledWith(language)
  }
  expect(() => update({ sender: {} }, { language: 'en' })).toThrow()
  expect(onLanguage).toHaveBeenCalledTimes(2)
})

it.each(['backup:import', 'backup:webdav'])('refreshes the menu when %s restores a different language', async (channel) => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  vault.updateSettings({ language: 'zh' })
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const restore = async () => { vault.updateSettings({ language: 'en' }) }
  const onLanguage = vi.fn()
  registerIpc({ vault, getWindow: () => win, onLanguage,
    backup: { importFrom: restore, webdav: restore }, sessions: { pool: { invalidateAll() {} } }
  } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  await handler({ sender: win.webContents }, channel === 'backup:import' ? '/tmp/backup' : 'pull', null, 'replace', 'restore-request')
  expect(onLanguage).toHaveBeenCalledExactlyOnceWith('en')
})

it('guards read-only FX IPC and rolls back a failed display-currency save', async () => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const value = { date: '2026-11-18', base: 'EUR', rates: { EUR: 1 }, source: 'ecb', fetchedAt: 0 }
  const save = vi.fn()
  registerIpc({ vault, fx: { read: () => value }, getWindow: () => win, save, onTheme() {}, backup: { status: () => ({ unlocked: true }), scheduleAuto() {} } } as unknown as IpcDeps)
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  expect(() => handler('fx:read')({ sender: {} })).toThrow('拒绝')
  expect(handler('fx:read')({ sender: win.webContents })).toEqual(value)
  expect(mocks.handle.mock.calls.some(([name]) => name === 'fx:refresh')).toBe(false)
  const before = vault.snapshot(); save.mockImplementationOnce(() => { throw new Error('fixture disk full') })
  expect(() => handler('settings:update')({ sender: win.webContents }, { displayCurrency: 'USD' })).toThrow('disk full')
  expect(vault.snapshot()).toEqual(before)
  handler('settings:update')({ sender: win.webContents }, { displayCurrency: 'USD' })
  expect(vault.settingsPublic(false).displayCurrency).toBe('USD')
})
