import { expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
const mocks = vi.hoisted(() => ({ connect: vi.fn(), exec: vi.fn() }))
vi.mock('../src/main/ssh/connect', () => ({ connectEndpoint: mocks.connect }))
vi.mock('../src/main/ssh/exec', () => ({ execOnClient: mocks.exec }))
import { loginAsNewUser, validateInitAuth } from '../src/main/init-gates'

it.each([true, false])('preserves target, proxy and jump credentials and closes every fresh connection on sudo success=%s', async (success) => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const host = vault.saveHost({ groupId: null, name: 'target', host: 'example.invalid', port: 2222, username: 'root', authType: 'password', password: 'old',
    connectionTimeoutSec: 18, keepaliveIntervalSec: 0,
    proxy: { type: 'socks5', host: 'proxy.invalid', port: 1080, password: 'proxy-secret' }, jumps: [{ host: 'jump.invalid', port: 2200, username: 'jump', authType: 'password', password: 'jump-secret' }] })
  const opened = { client: { end: vi.fn() }, jumps: [{ end: vi.fn() }, { end: vi.fn() }] }, verifyHost = vi.fn(async () => true)
  mocks.connect.mockResolvedValue(opened); mocks.exec.mockResolvedValue({ code: success ? 0 : 1 })
  const params = { USER: 'admin', PUBKEY: 'ssh-ed25519 AAAA', USER_PASSWORD: 'new-secret' }, signal = new AbortController().signal
  expect(await loginAsNewUser(vault, host.id, { type: 'privateKey', privateKeyPath: '/test/key', passphrase: 'phrase' }, params, verifyHost, signal)).toMatchObject({ ok: success })
  expect(mocks.connect).toHaveBeenLastCalledWith(expect.objectContaining({ host: host.host, port: 2222, username: 'admin', connectionTimeoutSec: 18, keepaliveIntervalSec: 0, auth: expect.objectContaining({ authType: 'privateKey', privateKeyPath: '/test/key', password: null, passphrase: 'phrase' }) }),
    expect.objectContaining({ signal, verifyHost, proxy: expect.objectContaining({ host: 'proxy.invalid', password: 'proxy-secret' }), jumps: [expect.objectContaining({ username: 'jump', auth: expect.objectContaining({ password: 'jump-secret' }) })] }))
  expect(mocks.exec).toHaveBeenLastCalledWith(opened.client, "sudo -S -p '' -v", { stdin: 'new-secret\n', signal })
  expect(opened.client.end).toHaveBeenCalledOnce(); for (const jump of opened.jumps) expect(jump.end).toHaveBeenCalledOnce()
})
it('closes fresh connections even when exec throws, and never returns private errors or passwords', async () => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec()), host = vault.saveHost({ groupId: null, name: 'host', host: 'example.invalid', port: 22, username: 'root', authType: 'password' })
  const opened = { client: { end: vi.fn() }, jumps: [] }; mocks.connect.mockResolvedValue(opened); mocks.exec.mockRejectedValue(Error('secret-password'))
  expect(await loginAsNewUser(vault, host.id, { type: 'agent' }, { USER: 'newuser', PUBKEY: 'ssh-ed25519 AAAA', USER_PASSWORD: 'secret-password' }, async () => false)).toEqual({ ok: false, reason: 'init.loginFailed' })
  expect(opened.client.end).toHaveBeenCalledOnce()
})
it('rejects malformed authentication at the IPC boundary', () => {
  for (const auth of [null, {}, { type: 'password' }, { type: 'privateKey' }, { type: 'privateKey', privateKeyPath: ' ' }, { type: 'agent', socket: 4 }, { type: 'agent', passphrase: 4 }]) {
    expect(() => validateInitAuth(auth as never)).toThrow('init.invalidAuth')
  }
})
