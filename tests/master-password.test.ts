import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSafeCodec, LockedError, safeStorageAvailable, setSecretKeyProvider } from '../src/main/secrets'
import { KEYSTORE_UNREADABLE } from '../src/shared/host-secrets'
import { BackupService } from '../src/main/backup/service'
import { registerIpc, type IpcDeps } from '../src/main/ipc'
import { emptyStore, Vault, type SecretCodec } from '../src/core/vault'
import { deriveBackupKey, encryptVault } from '../src/core/backup-format'
import { getSodium } from '../src/core/sodium'
import { ConnectionPool } from '../src/main/ssh/pool'
import { execOnClient } from '../src/main/ssh/exec'
import { startMiniSshd } from './support/mini-sshd.mjs'

const { keystore, handlers } = vi.hoisted(() => ({
  keystore: { available: false, failure: '' }, handlers: new Map<string, (...args: any[]) => any>()
}))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => {
      if (keystore.failure === 'availability') throw new Error('Electron keychain probe failed')
      return keystore.available
    },
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (bytes: Buffer) => {
      if (keystore.failure === 'decrypt') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString')
      return bytes.toString()
    }
  },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler), on: vi.fn() }
}))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

const legacy: SecretCodec = {
  encrypt: (plain) => `plain:${Buffer.from(plain).toString('base64')}`,
  decrypt: (payload) => Buffer.from(payload.slice(6), 'base64').toString()
}
const input = { groupId: null, name: '主机', host: 'localhost', port: 22, username: 'hop', authType: 'password' as const }
const password = 'master-password'
let directory: string
beforeEach(() => {
  keystore.available = false
  keystore.failure = ''
  handlers.clear()
  setSecretKeyProvider(() => null)
  vi.stubEnv('HOPLINE_DISABLE_KEYSTORE', '')
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-master-'))
})
afterEach(() => {
  setSecretKeyProvider(() => null)
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

function wire(vault: Vault) {
  const save = vi.fn(() => fs.writeFileSync(path.join(directory, 'hosts.json'), JSON.stringify(vault.snapshot())))
  const service = new BackupService(vault, path.join(directory, 'backups'), path.join(directory, 'key'), save)
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  registerIpc({ vault, backup: service, save, getWindow: () => win,
    sessions: { pool: { invalidate: vi.fn() } } } as unknown as IpcDeps)
  return { vault, service, save, event: { sender: win.webContents } }
}

async function configured(vault = new Vault(emptyStore(), createSafeCodec())) {
  const { file, params } = await encryptVault(Buffer.from('hopline-vault-ok'), password, { opslimit: 1, memlimit: 8192 })
  vault.setBackupUnlock({ ...params, salt: Buffer.from(params.salt).toString('base64') }, Buffer.from(file).toString('base64'))
  return { ...wire(vault), params }
}

describe('master password secret codec', () => {
  it('keeps safe: when the keystore is available, and honors the test switch', () => {
    keystore.available = true
    const codec = createSafeCodec()
    const encrypted = codec.encrypt('密钥')
    expect(encrypted).toMatch(/^safe:/)
    expect(codec.decrypt(encrypted)).toBe('密钥')
    vi.stubEnv('HOPLINE_DISABLE_KEYSTORE', '1')
    expect(safeStorageAvailable()).toBe(false)
    expect(() => codec.encrypt('secret')).toThrow(LockedError)
  })

  it.each(['unavailable', 'availability', 'decrypt'])('normalizes keychain read failures (%s)', failure => {
    keystore.available = true
    const codec = createSafeCodec()
    const encrypted = codec.encrypt('fixture')
    keystore.available = failure !== 'unavailable'
    keystore.failure = failure
    expect(() => codec.decrypt(encrypted)).toThrow(new Error(KEYSTORE_UNREADABLE.zh))
    expect(() => createSafeCodec(() => 'en').decrypt(encrypted)).toThrow(new Error(KEYSTORE_UNREADABLE.en))
  })

  it('refuses locked writes and mp: reads while retaining legacy reads', () => {
    const codec = createSafeCodec()
    expect(() => codec.encrypt('secret')).toThrow(LockedError)
    expect(() => codec.decrypt('mp:')).toThrow(LockedError)
    expect(codec.decrypt(legacy.encrypt('旧密钥'))).toBe('旧密钥')
  })

  it('round-trips mp:, randomizes nonces, authenticates ciphertext/AAD and rejects another key', async () => {
    const sodium = await getSodium()
    let key = sodium.randombytes_buf(32)
    setSecretKeyProvider(() => key)
    const codec = createSafeCodec()
    const encrypted = codec.encrypt('私钥\n密码')
    expect(encrypted).toMatch(/^mp:/)
    expect(codec.encrypt('私钥\n密码')).not.toBe(encrypted)
    expect(codec.decrypt(encrypted)).toBe('私钥\n密码')
    const bytes = Buffer.from(encrypted.slice(3), 'base64')
    expect(() => sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes.subarray(24), 'wrong-aad', bytes.subarray(0, 24), key)).toThrow()
    bytes[bytes.length - 1] ^= 1
    expect(() => codec.decrypt(`mp:${bytes.toString('base64')}`)).toThrow()
    expect(() => codec.decrypt('mp:AA==')).toThrow()
    key = sodium.randombytes_buf(32)
    expect(() => codec.decrypt(encrypted)).toThrow()
  })

  it('derives a deterministic separate subkey and wipes it on lock', async () => {
    const { service, params } = await configured()
    await service.unlock(password, false)
    const held = service.secretKey()!
    const expected = held.slice()
    const backupKey = await deriveBackupKey(password, params)
    expect(held).not.toEqual(backupKey)
    expect(held).toEqual((await getSodium()).crypto_kdf_derive_from_key(32, 1, 'hlsecret', backupKey))
    const ciphertext = createSafeCodec().encrypt('test')
    await service.lock()
    expect(held.every((byte) => byte === 0)).toBe(true)
    expect(service.secretKey()).toBeNull()
    expect(() => createSafeCodec().decrypt(ciphertext)).toThrow(LockedError)
    await expect(service.unlock('wrong-password', false)).rejects.toThrow('主密码不正确')
    expect(service.secretKey()).toBeNull()
    await service.unlock(password, false)
    expect(service.secretKey()).toEqual(expected)
    expect(createSafeCodec().decrypt(ciphertext)).toBe('test')
    await expect(service.setPassword('new-password', false)).rejects.toThrow('已设置主密码')
    expect(createSafeCodec().decrypt(ciphertext)).toBe('test')
    const otherMaster = await deriveBackupKey('other-password', params)
    const otherKey = (await getSodium()).crypto_kdf_derive_from_key(32, 1, 'hlsecret', otherMaster)
    setSecretKeyProvider(() => otherKey)
    expect(() => createSafeCodec().decrypt(ciphertext)).toThrow()
  })
})

describe('legacy migration and save', () => {
  it.each([false, true])('migrates every legacy field once with keystore=%s without changing timestamps/version', async (available) => {
    const source = new Vault(emptyStore(), legacy)
    const host = source.saveHost({ ...input, password: 'password', privateKey: 'private', passphrase: 'phrase',
      proxy: { type: 'socks5', host: 'proxy', port: 1080, password: 'proxy-password' },
      jumps: Array.from({ length: 5 }, (_, i) => ({ host: `jump${i}`, port: 22, username: 'hop', authType: 'password',
        password: `jump-password${i}`, privateKey: `jump-private${i}`, passphrase: `jump-phrase${i}` })) })
    source.updateSettings({ webdav: { url: 'https://dav.test', username: 'user', password: 'dav', remoteDir: 'hopline' },
      s3: { endpoint: 'https://s3.test', bucket: 'bucket', region: '', accessKeyId: 'id', secretAccessKey: 's3', prefix: '', forcePathStyle: true } })
    const vault = new Vault(source.snapshot(), createSafeCodec())
    const before = vault.snapshot()
    const plain = vault.exportPortable('fixed')
    const { service, save } = await configured(vault)
    keystore.available = available
    await service.unlock(password, false)
    expect(save).toHaveBeenCalledTimes(1)
    const after = vault.snapshot()
    expect(after.version).toBe(9)
    expect(after.hosts[0].updatedAt).toBe(before.hosts[0].updatedAt)
    expect(after.hosts[0].createdAt).toBe(before.hosts[0].createdAt)
    const fields = [after.hosts[0], ...after.hosts[0].jumps].flatMap((item) => [item.passwordEnc, item.privateKeyEnc, item.passphraseEnc])
    fields.push(after.hosts[0].proxy!.passwordEnc, after.settings.backup.webdav!.passwordEnc, after.settings.backup.s3!.secretAccessKeyEnc)
    expect(fields).toHaveLength(21)
    expect(fields.every((value) => value?.startsWith(available ? 'safe:' : 'mp:'))).toBe(true)
    expect(vault.exportPortable('fixed').hosts).toEqual(plain.hosts)
    expect(vault.webdavPassword()).toBe('dav')
    expect(vault.s3Secret()).toBe('s3')
    expect(vault.secretsOf(host.id).password).toBe('password')
    await service.unlock(password, false)
    expect(vault.snapshot().hosts).toEqual(after.hosts)
    expect(vault.snapshot().settings.backup.webdav).toEqual(after.settings.backup.webdav)
  })

  it('does not touch safe:/mp: and rolls back all fields if migration fails', async () => {
    const { vault, service } = await configured()
    await service.unlock(password, false)
    const mp = vault.saveHost({ ...input, password: 'mp-secret' })
    keystore.available = true
    const safe = vault.saveHost({ ...input, password: 'safe-secret' })
    const data = vault.snapshot()
    data.hosts.push({ ...data.hosts[0], id: 'old', passwordEnc: legacy.encrypt('old'), privateKeyEnc: legacy.encrypt('key') })
    vault.replace(data)
    const encrypt = vi.fn().mockReturnValueOnce('mp:new').mockImplementationOnce(() => { throw new Error('failed') })
    expect(() => vault.reencryptSecrets((value) => value.startsWith('plain:'), { encrypt, decrypt: vi.fn() })).toThrow('failed')
    expect(vault.snapshot()).toEqual(data)
    expect(vault.reencryptSecrets((value) => value.startsWith('plain:'), createSafeCodec())).toBe(2)
    for (const id of [mp.id, safe.id]) expect(vault.snapshot().hosts.find((host) => host.id === id)).toEqual(data.hosts.find((host) => host.id === id))
  })

  it('rejects locked host saves before modifying the old record and restores remembered keys', async () => {
    const { vault, service, event } = await configured()
    await service.unlock(password, false)
    const host = vault.saveHost({ ...input, password: 'test' })
    await service.lock()
    const before = vault.snapshot()
    expect(() => handlers.get('hosts:save')!(event, { ...input, id: host.id, name: 'changed', passphrase: 'new' })).toThrow(LockedError)
    expect(vault.snapshot()).toEqual(before)
    keystore.available = true
    await service.unlock(password, true)
    const expected = service.secretKey()!.slice()
    const restored = new BackupService(vault, path.join(directory, 'backup'), path.join(directory, 'key'), vi.fn())
    await restored.init()
    expect(restored.secretKey()).toEqual(expected)
    vi.stubEnv('HOPLINE_DISABLE_KEYSTORE', '1')
    const savedKey = fs.readFileSync(path.join(directory, 'key'))
    const disabled = new BackupService(vault, directory, path.join(directory, 'key'), vi.fn())
    await disabled.init()
    expect(disabled.status().unlocked).toBe(false)
    expect(disabled.secretKey()).toBeNull()
    expect(fs.readFileSync(path.join(directory, 'key'))).toEqual(savedKey)
  })
})

it('connects through real mini-sshd after unlocking an mp: host', async () => {
  const server = await startMiniSshd({ password: 'test', root: path.join(directory, 'sshd') })
  const { vault, service } = await configured()
  const pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null })
  try {
    await service.unlock(password, false)
    const host = vault.saveHost({ ...input, host: '127.0.0.1', port: server.port, password: 'test' })
    const restarted = wire(new Vault(vault.snapshot(), createSafeCodec()))
    await restarted.service.init()
    expect(restarted.service.status().unlocked).toBe(false)
    await expect(pool.acquire(host.id)).rejects.toThrow(LockedError)
    expect(server.acceptedConnections).toBe(0)
    await restarted.service.unlock(password, false)
    const lease = await pool.acquire(host.id)
    expect((await execOnClient(lease.client, 'printf unlocked')).stdout).toBe('unlocked')
    lease.release()
  } finally {
    await pool.closeAll()
    await server.close()
  }
})

it('sets the first password, saves only mp: on disk, and unlocks the same secrets after a restart', async () => {
  const { vault, service, event } = wire(new Vault(emptyStore(), createSafeCodec()))
  const saveHost = handlers.get('hosts:save')!
  expect(() => saveHost(event, { ...input, password: 'host-secret' })).toThrow(LockedError)
  expect(vault.listHosts()).toEqual([])
  await service.setPassword(password, false)
  saveHost(event, { ...input, password: 'host-secret' })
  const disk = fs.readFileSync(path.join(directory, 'hosts.json'), 'utf8')
  expect(disk).toContain('mp:')
  expect(disk).not.toContain('host-secret')
  expect(disk).not.toContain('plain:')
  await service.lock()
  const restarted = wire(new Vault(JSON.parse(disk), createSafeCodec()))
  await restarted.service.init()
  const hostId = restarted.vault.listHosts()[0].id
  expect(() => restarted.vault.secretsOf(hostId)).toThrow(LockedError)
  await restarted.service.unlock(password, false)
  expect(restarted.vault.secretsOf(hostId).password).toBe('host-secret')
})
