import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Client } from 'ssh2'
import { MemorySecretCodec, Vault, emptyStore, type StoredHost } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'
import * as sshConnect from '../src/main/ssh/connect'

let vault: Vault, pool: ConnectionPool, hostId: string
const client = () => Object.assign(new EventEmitter(), { end: vi.fn() }) as unknown as Client
beforeEach(() => {
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  hostId = vault.saveHost({ name: '测试主机', groupId: null, host: 'example.test', port: 22, username: 'user', authType: 'password', password: 'fake-password' }).id
  pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null })
  vi.spyOn(sshConnect, 'connectEndpoint').mockImplementation(async () => ({ client: client(), jumps: [] }))
})
afterEach(async () => { await pool.closeAll(); vi.restoreAllMocks() })

const changes: Array<[string, (host: StoredHost) => void]> = [
  ['address', host => { host.host = 'other.test' }], ['port', host => { host.port = 2222 }], ['username', host => { host.username = 'other' }],
  ['authentication mode', host => { host.authType = 'privateKey' }], ['password', host => { host.passwordEnc = 'mem:changed' }],
  ['private key', host => { host.privateKeyEnc = 'mem:key' }], ['private key path', host => { host.privateKeyPath = '/new-key' }],
  ['passphrase', host => { host.passphraseEnc = 'mem:passphrase' }], ['agent', host => { host.agent = { socket: '/new-agent', identityFile: null, forward: false } }],
  ['proxy', host => { host.proxy = { type: 'socks5', host: 'proxy.test', port: 1080, username: 'proxy-user', passwordEnc: 'mem:proxy' } }],
  ['jump authentication', host => { host.jumps = [{ host: 'jump.test', port: 22, username: 'jump-user', authType: 'password', passwordEnc: 'mem:jump', privateKeyEnc: null, privateKeyPath: null, passphraseEnc: null, agent: null }] }],
  ['timeout', host => { host.connectionTimeoutSec = 40 }], ['keepalive', host => { host.keepaliveIntervalSec = 15 }]
]
it.each(changes)('rejects a stale authorization when %s changes before any connection is opened', async (_name, change) => {
  const target = pool.connectionTarget(hostId)
  change(vault.getHost(hostId)!)
  await expect(pool.acquire(hostId, { expectedTarget: target })).rejects.toThrow('runbook.targetChanged')
  expect(sshConnect.connectEndpoint).not.toHaveBeenCalled()
})

it('does not expire a preview merely because presentation or billing metadata changed', () => {
  const target = pool.connectionTarget(hostId), host = vault.getHost(hostId)!
  host.name = '新名称'; host.groupId = 'other-group'; host.meta.note = '备注'; host.updatedAt++
  expect(pool.connectionTarget(hostId)).toBe(target)
})

it('does not open a deferred reservation with newly edited credentials', async () => {
  const pending = pool.acquire(hostId, { expectedTarget: pool.connectionTarget(hostId) })
  vault.getHost(hostId)!.host = 'other.test'
  await expect(pending).rejects.toThrow('runbook.targetChanged')
  expect(sshConnect.connectEndpoint).not.toHaveBeenCalled()
})

it('rejects after an awaited handshake and releases a retired reservation', async () => {
  let finish!: () => void
  const opened = client()
  vi.mocked(sshConnect.connectEndpoint).mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { finish = resolve })
    return { client: opened, jumps: [] }
  })
  const pending = pool.acquire(hostId, { expectedTarget: pool.connectionTarget(hostId) })
  await vi.waitFor(() => expect(sshConnect.connectEndpoint).toHaveBeenCalledOnce())
  vault.getHost(hostId)!.username = 'other'; pool.invalidate(hostId); finish()
  await expect(pending).rejects.toThrow('runbook.targetChanged')
  expect(opened.end).toHaveBeenCalledOnce()
})

it('does not silently reuse an old connection after changed credentials without explicit invalidation', async () => {
  const first = await pool.acquire(hostId)
  vault.saveHost({ ...vault.getHost(hostId)!, password: 'new-fake-password' })
  const next = await pool.acquire(hostId, { expectedTarget: pool.connectionTarget(hostId) })
  expect(next.client).not.toBe(first.client)
  expect(sshConnect.connectEndpoint).toHaveBeenCalledTimes(2)
  first.release(); next.release()
})

it('keeps an exec authorization through the foreground retry of a failed background handshake', async () => {
  let fail!: (error: Error) => void
  vi.mocked(sshConnect.connectEndpoint).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  const target = pool.connectionTarget(hostId)
  const background = pool.acquire(hostId, { interaction: 'forbid' })
  const backgroundFailure = expect(background).rejects.toMatchObject({ reason: 'authentication' })
  await vi.waitFor(() => expect(sshConnect.connectEndpoint).toHaveBeenCalledOnce())
  const work = pool.exec(hostId, 'must-not-run', { expectedTarget: target, beforeStart() {
    if (pool.connectionTarget(hostId) !== target) throw new Error('runbook.targetChanged')
  } })
  const rejected = expect(work).rejects.toThrow('runbook.targetChanged')
  vault.getHost(hostId)!.host = 'other.test'
  fail(new sshConnect.SshConnectionError('authentication', '认证需要交互输入'))
  await backgroundFailure; await rejected
  expect(sshConnect.connectEndpoint).toHaveBeenCalledOnce()
})
