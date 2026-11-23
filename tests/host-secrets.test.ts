import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HostSecrets, SECRET_AUTH_MS, SECRET_CLIPBOARD_MS, SECRET_DISPOSE_MS, secretField } from '../src/main/host-secrets'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'

let vault: Vault, id: string, locked: boolean, supported: boolean
let stored: { text: string; token: string }, prompt: ReturnType<typeof vi.fn<() => Promise<void>>>, clear: ReturnType<typeof vi.fn<() => void>>
let service: HostSecrets
const caller = vi.fn()
beforeEach(() => {
  vi.useFakeTimers({ now: 1000 }); locked = false; supported = true
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  id = vault.saveHost({ groupId: null, name: 'A', host: '127.0.0.1', port: 22, username: 'root', authType: 'password', password: 'fixture-secret', passphrase: 'fixture-phrase', privateKey: 'fixture-key', proxy: { type: 'socks5', host: 'localhost', port: 1080, password: 'proxy-secret' }, jumps: [{ host: 'localhost', port: 22, username: 'root', authType: 'password', password: 'jump-secret' }] }).id
  stored = { text: '', token: '' }; prompt = vi.fn(async () => {}); clear = vi.fn(() => { stored = { text: '', token: '' } })
  service = new HostSecrets({ vault, locked: () => locked, canPromptTouchID: () => supported, promptTouchID: prompt, clipboard: {
    write: async (text, token) => { stored = { text, token } }, matches: async (text, token) => stored.text === text && stored.token === token, clear
  } })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
it('allows only known fields and forbids accessing all private keys', () => {
  for (const field of [Object.assign(Object.create({ field: 'password' }), { jumpIndex: 0, extra: true }), null, {}, '__proto__', 'privateKeyPath', { jumpIndex: -1, field: 'password' }, { jumpIndex: 5, field: 'password' }, { jumpIndex: 0, field: 'password', extra: true }]) expect(() => secretField(field)).toThrow()
  expect(() => secretField('privateKey')).toThrow()
  expect(() => secretField({ jumpIndex: 0, field: 'privateKey' })).toThrow()
})
it('authenticates once for five minutes, copies without returning plaintext, and supports scoped fields', async () => {
  expect(await service.copy(id, 'password', caller)).toBeUndefined()
  expect(stored.text).toBe('fixture-secret'); expect(stored.token).toBeTruthy()
  expect(await service.reveal(id, 'passphrase', caller)).toBe('fixture-phrase')
  expect(await service.reveal(id, 'proxyPassword', caller)).toBe('proxy-secret')
  expect(await service.reveal(id, { jumpIndex: 0, field: 'password' }, caller)).toBe('jump-secret')
  await expect(service.copy(id, 'privateKey', caller)).rejects.toThrow('字段')
  await expect(service.copy(id, { jumpIndex: 0, field: 'privateKey' }, caller)).rejects.toThrow('字段')
  expect(prompt).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(SECRET_AUTH_MS)
  await service.reveal(id, 'password', caller); expect(prompt).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(vault.listHosts())).not.toContain('fixture-secret')
})
it('refuses locked libraries and authentication failure before decrypting or writing', async () => {
  const decrypt = vi.spyOn(vault, 'readHostSecret')
  locked = true; await expect(service.copy(id, 'password', caller)).rejects.toThrow('锁定')
  expect(prompt).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled()
  locked = false; prompt.mockRejectedValueOnce(new Error('cancelled'))
  await expect(service.reveal(id, 'password', caller)).rejects.toThrow('身份验证未通过')
  expect(stored.text).toBe(''); expect(decrypt).not.toHaveBeenCalled()
  await service.reveal(id, 'password', caller); expect(prompt).toHaveBeenCalledTimes(2)
})
it('rechecks lock and caller after asynchronous authentication', async () => {
  prompt.mockImplementationOnce(async () => { locked = true })
  await expect(service.copy(id, 'password', caller)).rejects.toThrow('锁定')
  locked = false; prompt.mockImplementationOnce(async () => {})
  await expect(service.reveal(id, 'password', () => { throw new Error('foreign caller') })).rejects.toThrow('foreign caller')
  expect(stored.text).toBe('')
})
it('permits unsupported Touch ID or an explicitly disabled setting without a prompt', async () => {
  supported = false; await service.reveal(id, 'password', caller)
  supported = true; vault.updateSettings({ verifySecrets: false }); await service.copy(id, 'password', caller)
  expect(prompt).not.toHaveBeenCalled()
})
it('clears unchanged secret clipboard at 60 seconds, but preserves later user data and same-text replacements', async () => {
  await service.copy(id, 'password', caller)
  await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_MS - 1); expect(clear).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); expect(clear).toHaveBeenCalledOnce()
  await service.copy(id, 'password', caller); stored = { text: 'fixture-secret', token: '' }
  await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_MS); expect(clear).toHaveBeenCalledOnce()
  await service.copy(id, 'password', caller); stored = { text: 'user copied something else', token: '' }
  await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_MS); expect(clear).toHaveBeenCalledOnce()
})
it('restarts the secret clipboard timer after each copy', async () => {
  await service.copy(id, 'password', caller); await vi.advanceTimersByTimeAsync(30_000)
  await service.copy(id, 'passphrase', caller); await vi.advanceTimersByTimeAsync(30_000)
  expect(clear).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(30_000); expect(clear).toHaveBeenCalledOnce()

})
it('defaults old settings to verification enabled and validates mutations', () => {
  const old = vault.snapshot(); delete (old.settings as any).verifySecrets
  const migrated = new Vault(old, new MemorySecretCodec()); expect(migrated.settingsPublic(false).verifySecrets).toBe(true)
  expect(() => migrated.updateSettings({ verifySecrets: 'false' } as any)).toThrow()
  migrated.updateSettings({ verifySecrets: false }); expect(migrated.exportPortable().settings.verifySecrets).toBe(false)
})

it('disposes before the 60-second deadline, cancels its timer and denies late requests', async () => {
  await service.copy(id, 'password', caller); await vi.advanceTimersByTimeAsync(1000)
  await service.dispose(); await service.dispose()
  expect(stored.text).toBe(''); expect(clear).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_MS); expect(clear).toHaveBeenCalledOnce()
  await expect(service.reveal(id, 'password', caller)).rejects.toThrow('退出')
})
it.each(['different-text', 'same-text-new-owner'])('preserves changed clipboard on disposal: %s', async kind => {
  await service.copy(id, 'password', caller)
  stored = kind === 'different-text' ? { ...stored, text: 'user text' } : { text: 'fixture-secret', token: 'another owner' }
  await service.dispose(); await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_MS)
  expect(clear).not.toHaveBeenCalled()
})
it('never downgrades local verification during either backup import mode', () => {
  const backup = vault.exportPortable(); backup.settings.verifySecrets = false
  for (const mode of ['merge', 'replace'] as const) {
    vault.importPortable(backup, mode); expect(vault.settingsPublic(true).verifySecrets).toBe(true)
  }
  vault.updateSettings({ verifySecrets: false }); vault.importPortable(backup, 'merge')
  expect(vault.settingsPublic(true).verifySecrets).toBe(false)
  backup.settings.verifySecrets = true; vault.importPortable(backup, 'replace')
  expect(vault.settingsPublic(true).verifySecrets).toBe(true)
})

it('waits for an in-flight clipboard write before disposing, so no secret lands after cleanup', async () => {
  let finish!: () => void, started!: () => void
  const beginning = new Promise<void>(resolve => { started = resolve })
  const ready = new Promise<void>(resolve => { finish = resolve })
  const pending = new HostSecrets({ vault, locked: () => false, canPromptTouchID: () => false, promptTouchID: prompt,
    clipboard: { write: async (text, token) => { started(); await ready; stored = { text, token } },
      matches: async (text, token) => stored.text === text && stored.token === token, clear } })
  const copying = pending.copy(id, 'password', caller)
  await beginning
  const disposing = pending.dispose()
  expect(clear).not.toHaveBeenCalled()
  finish(); await copying; await disposing
  expect(clear).toHaveBeenCalledOnce(); expect(stored.text).toBe('')
  await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_MS); expect(clear).toHaveBeenCalledOnce()
})
it('does not clear twice when the expiry timer and quit race for the same item', async () => {
  const checks: ((matches: boolean) => void)[] = []
  const racing = new HostSecrets({ vault, locked: () => false, canPromptTouchID: () => false, promptTouchID: prompt,
    clipboard: { write: async (text, token) => { stored = { text, token } }, matches: () => new Promise(resolve => checks.push(resolve)), clear } })
  await racing.copy(id, 'password', caller)
  await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_MS)
  const disposing = racing.dispose()
  await Promise.resolve(); await Promise.resolve()
  expect(checks).toHaveLength(2)
  checks.forEach(resolve => resolve(true)); await disposing
  expect(clear).toHaveBeenCalledOnce()
})
it('abandons a stalled clipboard read after one second and never clears on its late result', async () => {
  let finish!: (value: boolean) => void
  const stalled = new HostSecrets({ vault, locked: () => false, canPromptTouchID: () => false, promptTouchID: prompt,
    clipboard: { write: async (text, token) => { stored = { text, token } }, matches: () => new Promise(resolve => { finish = resolve }), clear } })
  await stalled.copy(id, 'password', caller)
  let done = false
  const disposing = stalled.dispose().then(() => { done = true })
  await vi.advanceTimersByTimeAsync(SECRET_DISPOSE_MS - 1); expect(done).toBe(false)
  await vi.advanceTimersByTimeAsync(1); await disposing; expect(done).toBe(true)
  finish(true); await Promise.resolve(); await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_MS)
  expect(clear).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
})
it('bounds a stalled write too, without starting later queued clipboard work after the deadline', async () => {
  let finish!: () => void, started!: () => void
  const beginning = new Promise<void>(resolve => { started = resolve })
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const write = vi.fn(async () => { started(); await waiting })
  const stalled = new HostSecrets({ vault, locked: () => false, canPromptTouchID: () => false, promptTouchID: prompt,
    clipboard: { write, matches: async () => true, clear } })
  const first = stalled.copy(id, 'password', caller), second = stalled.copy(id, 'passphrase', caller)
  await beginning
  const disposing = stalled.dispose()
  await vi.advanceTimersByTimeAsync(SECRET_DISPOSE_MS); await disposing
  finish(); await first; await second
  expect(write).toHaveBeenCalledOnce(); expect(clear).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['password', 'test-password', '密码：test-password', 'Password: test-password'],
  ['password', null, '认证：交互', 'Auth: Interactive'],
  ['privateKey', null, '认证：私钥', 'Auth: Private key'],
  ['agent', null, '认证：SSH Agent', 'Auth: SSH Agent'],
  ['keyboard-interactive', null, '认证：交互', 'Auth: Interactive']
] as const)('copies a localized card for %s with password %s without reading other secrets', async (authType, password, zh, en) => {
  const decrypt = vi.spyOn(vault, 'readHostSecret')
  const host = vault.saveHost({ groupId: null, name: 'Carbon', host: '127.0.0.1', port: 2200, username: 'fixture',
    authType, password, passphrase: 'forbidden-phrase', privateKey: 'forbidden-key', meta: { note: 'zone A\r\nrack 2' } })
  expect(await service.copyConnectionCard(host.id, caller)).toBeUndefined()
  expect(stored.text.split('\n')).toEqual(['名称：Carbon（备注：zone A rack 2）', 'IP：127.0.0.1', '端口：2200', '用户名：fixture', zh])
  vault.updateSettings({ language: 'en' })
  await service.copyConnectionCard(host.id, caller)
  expect(stored.text.split('\n')).toEqual(['Name: Carbon (Note: zone A rack 2)', 'IP: 127.0.0.1', 'Port: 2200', 'Username: fixture', en])
  vault.saveHost({ ...host, meta: { note: null } })
  await service.copyConnectionCard(host.id, caller)
  expect(stored.text.split('\n')[0]).toBe('Name: Carbon')
  vault.updateSettings({ language: 'zh' })
  await service.copyConnectionCard(host.id, caller)
  expect(stored.text.split('\n')[0]).toBe('名称：Carbon')
  expect(decrypt.mock.calls).toEqual(Array.from({ length: 4 }, () => [host.id, 'password']))
  expect(prompt).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_MS)
  expect(stored.text).toBe('')
})

it('blocks an unavailable saved password before prompting or changing the clipboard or vault', async () => {
  const unavailable = new Error('无法读取系统钥匙串中的 Hopline 密钥。')
  const checkKeystore = vi.fn(() => { throw unavailable })
  const write = vi.fn()
  const blocked = new HostSecrets({ vault, locked: () => false, canPromptTouchID: () => true, promptTouchID: prompt, checkKeystore,
    clipboard: { write, matches: async () => true, clear } })
  const before = vault.snapshot()
  await expect(blocked.copyConnectionCard(id, caller)).rejects.toThrow(unavailable)
  expect(checkKeystore).toHaveBeenCalledWith(vault.hostSecretPayload(id, 'password'))
  expect(prompt).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  expect(vault.snapshot()).toEqual(before)
})
