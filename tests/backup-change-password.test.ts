import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vault, emptyStore } from '../src/core/vault'
import { writeJsonFile } from '../src/core/json-file'
import { decryptVault } from '../src/core/backup-format'
import { BackupService } from '../src/main/backup/service'
import { createSafeCodec, setSecretKeyProvider } from '../src/main/secrets'
import * as secrets from '../src/main/secrets'
import { logError, logInfo } from '../src/main/logger'
import { buildDiagnostics } from '../src/main/diagnostics'

const keystore = vi.hoisted(() => ({ available: false }))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => keystore.available,
  encryptString: (text: string) => Buffer.from(text),
  decryptString: (bytes: Buffer) => bytes.toString()
} }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('../src/core/backup-format', async (original) => {
  const actual = await original<typeof import('../src/core/backup-format')>()
  return { ...actual, createKdfParams: () => actual.createKdfParams({ opslimit: 1, memlimit: 8192 }) }
})

const current = 'old-master-password', next = 'new-master-password'
let directory: string, storeFile: string, keyFile: string
let vault: Vault, service: BackupService, save: ReturnType<typeof vi.fn<() => void>>

beforeEach(async () => {
  keystore.available = false
  vi.stubEnv('HOPLINE_DISABLE_KEYSTORE', '')
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-change-'))
  storeFile = path.join(directory, 'hosts.json')
  keyFile = path.join(directory, 'keys', 'remembered')
  vault = new Vault(emptyStore(), createSafeCodec())
  save = vi.fn(() => writeJsonFile(storeFile, vault.snapshot()))
  service = new BackupService(vault, path.join(directory, 'backups'), keyFile, save)
  setSecretKeyProvider(() => service.secretKey())
  await service.setPassword(current, false)
  for (let i = 0; i < 2; i++) vault.saveHost({
    groupId: null, name: `host${i}`, host: `host${i}.test`, port: 22, username: 'user', authType: 'password',
    password: `host-password${i}`, privateKey: `host-private${i}`, passphrase: `host-passphrase${i}`,
    proxy: { type: 'socks5', host: 'proxy.test', port: 1080, password: `proxy-password${i}` },
    jumps: Array.from({ length: 2 }, (_, j) => ({ host: `jump${j}.test`, port: 22, username: 'jump', authType: 'password',
      password: `jump-password${i}${j}`, privateKey: `jump-private${i}${j}`, passphrase: `jump-passphrase${i}${j}` }))
  })
  vault.updateSettings({
    webdav: { url: 'https://dav.test', username: 'user', password: 'dav-secret', remoteDir: 'hopline' },
    s3: { endpoint: 'https://s3.test', bucket: 'bucket', region: '', accessKeyId: 'id', secretAccessKey: 's3-secret', prefix: '', forcePathStyle: true }
  })
  save()
  save.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  setSecretKeyProvider(() => null)
  fs.rmSync(directory, { recursive: true, force: true })
})

function before() {
  return { disk: fs.readFileSync(storeFile), data: vault.snapshot(), key: service.secretKey()?.slice(),
    remembered: fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null, status: service.status() }
}

async function unchanged(previous: ReturnType<typeof before>) {
  expect(fs.readFileSync(storeFile)).toEqual(previous.disk)
  expect(vault.snapshot()).toEqual(previous.data)
  expect(service.secretKey()).toEqual(previous.key ?? null)
  expect(service.status()).toEqual(previous.status)
  expect(fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null).toEqual(previous.remembered)
  await service.lock()
  await service.unlock(current, false)
  expect(service.status().unlocked).toBe(true)
}

function ciphertexts(data = vault.snapshot()) {
  return [...data.hosts.flatMap((host) => [host, ...host.jumps].flatMap((entry) => [entry.passwordEnc, entry.privateKeyEnc, entry.passphraseEnc]).concat(host.proxy?.passwordEnc ?? null)),
    data.settings.backup.webdav!.passwordEnc, data.settings.backup.s3!.secretAccessKeyEnc]
}

describe('master password rotation', () => {
  it.each([false, true])('rotates every mp: field in one save, starting locked=%s', async (locked) => {
    const expected = vault.exportPortable('fixed'), previous = before(), held = service.secretKey()!
    if (locked) await service.lock()
    const status = await service.changePassword(current, next, false)
    expect(status).toMatchObject({ hasPassword: true, unlocked: true, rememberUnlock: false })
    expect(save).toHaveBeenCalledTimes(1)
    expect(vault.kdf()!.salt).not.toBe(previous.data.settings.backup.kdf!.salt)
    expect(vault.verifier()).not.toBe(previous.data.settings.backup.verifier)
    expect(ciphertexts()).toHaveLength(22)
    ciphertexts().forEach((value, i) => {
      expect(value).toMatch(/^mp:/)
      expect(value).not.toBe(ciphertexts(previous.data)[i])
    })
    expect(vault.exportPortable('fixed')).toEqual(expected)
    expect(vault.snapshot().version).toBe(previous.data.version)
    expect(held.every((byte) => byte === 0)).toBe(true)
    service = new BackupService(new Vault(JSON.parse(fs.readFileSync(storeFile, 'utf8')), createSafeCodec()), directory, keyFile, vi.fn())
    await expect(service.unlock(current, false)).rejects.toThrow('主密码不正确')
    await service.unlock(next, false)
    expect(service.secretKey()).not.toEqual(previous.key)
    expect(vault.exportPortable('fixed')).toEqual(expected)
  })

  it('preserves safe: and plain: fields and does not run legacy migration during rotation', async () => {
    const data = vault.snapshot()
    data.hosts[0].passwordEnc = `plain:${Buffer.from('legacy').toString('base64')}`
    keystore.available = true
    data.hosts[1].passphraseEnc = createSafeCodec().encrypt('safe-phrase')
    vault.replace(data)
    save(); save.mockClear()
    const migrate = vi.fn(() => vault.reencryptSecrets((value) => value.startsWith('plain:'), createSafeCodec()))
    service.onUnlocked(migrate)
    await service.changePassword(current, next, false)
    expect(migrate).not.toHaveBeenCalled()
    expect(vault.snapshot().hosts[0].passwordEnc).toBe(data.hosts[0].passwordEnc)
    expect(vault.snapshot().hosts[1].passphraseEnc).toBe(data.hosts[1].passphraseEnc)
    expect(vault.secretsOf(data.hosts[0].id).password).toBe('legacy')
    expect(vault.secretsOf(data.hosts[1].id).passphrase).toBe('safe-phrase')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it.each(['wrong-master-password', '', 'short'])('rejects incorrect current password %j without changes', async (wrong) => {
    const previous = before()
    await expect(service.changePassword(wrong, next, false)).rejects.toThrow('主密码不正确')
    expect(save).not.toHaveBeenCalled()
    await unchanged(previous)
  })

  it.each([[current, '不能与当前'], ['short', '至少 8 位'], ['x'.repeat(201), '过长']])('rejects invalid new password', async (invalid, message) => {
    const previous = before()
    await expect(service.changePassword(current, invalid, false)).rejects.toThrow(message)
    expect(save).not.toHaveBeenCalled()
    await unchanged(previous)
  })

  it.each([1, 3, 22])('rolls back when ciphertext number %s cannot decrypt', async (nth) => {
    const previous = before(), real = secrets.reencryptMasterSecret
    let calls = 0
    vi.spyOn(secrets, 'reencryptMasterSecret').mockImplementation((payload, oldKey, newKey) => {
      return real(++calls === nth ? 'mp:AA==' : payload, oldKey, newKey)
    })
    await expect(service.changePassword(current, next, false)).rejects.toThrow()
    expect(calls).toBe(nth)
    expect(save).not.toHaveBeenCalled()
    await unchanged(previous)
  })

  it.each([false, true])('rolls back a partial write failure with remembered unlock=%s', async (remember) => {
    if (remember) { keystore.available = true; await service.unlock(current, true) }
    const previous = before(), real = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, bytes, options) => {
      if (typeof file === 'number') {
        real(file, 'partial file')
        throw new Error('disk full')
      }
      return real(file, bytes, options)
    })
    await expect(service.changePassword(current, next, remember)).rejects.toThrow('disk full')
    vi.restoreAllMocks()
    await unchanged(previous)
  })

  it('rolls back a failed atomic store rename, including the remembered key', async () => {
    keystore.available = true
    await service.unlock(current, true)
    const previous = before(), real = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === storeFile) throw new Error('rename failed')
      return real(from, to)
    })
    await expect(service.changePassword(current, next, true)).rejects.toThrow('rename failed')
    vi.restoreAllMocks()
    await unchanged(previous)
  })

  it('stays locked when saving a rotation from the locked state fails', async () => {
    await service.lock()
    const previous = before()
    save.mockImplementationOnce(() => { throw new Error('save failed') })
    await expect(service.changePassword(current, next, false)).rejects.toThrow('save failed')
    await unchanged(previous)
  })

  it('preserves the old remembered key if staging the sealed key cannot be written', async () => {
    keystore.available = true
    await service.unlock(current, true)
    const previous = before()
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('key write failed') })
    await expect(service.changePassword(current, next, true)).rejects.toThrow('key write failed')
    vi.restoreAllMocks()
    await unchanged(previous)
  })

  it('leaves everything intact if remembering is unavailable', async () => {
    const previous = before()
    await expect(service.changePassword(current, next, true)).rejects.toThrow('系统钥匙串不可用')
    expect(save).not.toHaveBeenCalled()
    await unchanged(previous)
  })

  it('restores the old sealed file if installing the new sealed file fails', async () => {
    keystore.available = true
    await service.unlock(current, true)
    const previous = before(), real = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(from)) === 'next') throw new Error('key rename failed')
      return real(from, to)
    })
    await expect(service.changePassword(current, next, true)).rejects.toThrow('key rename failed')
    vi.restoreAllMocks()
    await unchanged(previous)
  })

  it('allows only one simultaneous rotation', async () => {
    const results = await Promise.allSettled([service.changePassword(current, next, false), service.changePassword(current, 'other-password', false)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(save).toHaveBeenCalledTimes(1)
    await service.lock()
    await service.unlock(next, false)
  })

  it.each([false, true])('allows only one rotation/lock operation, lock first=%s', async (lockFirst) => {
    const expected = vault.exportPortable('fixed')
    const operations = lockFirst
      ? [service.lock(), service.changePassword(current, next, false)]
      : [service.changePassword(current, next, false), service.lock()]
    const results = await Promise.allSettled(operations)
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(service.status().unlocked).toBe(!lockFirst)
    await service.unlock(lockFirst ? current : next, false)
    expect(vault.exportPortable('fixed')).toEqual(expected)
  })

  it('rejects unlock during rotation instead of reinstalling an obsolete key', async () => {
    const results = await Promise.allSettled([service.changePassword(current, next, false), service.unlock(current, false)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(vault.secretsOf(vault.listHosts()[0].id).password).toBe('host-password0')
  })

  it('restarts with the new remembered key and decrypts the same host secrets', async () => {
    keystore.available = true
    await service.unlock(current, true)
    const oldSealed = fs.readFileSync(keyFile), expected = vault.exportPortable('fixed')
    save.mockClear()
    await service.changePassword(current, next, true)
    expect(save).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(keyFile)).not.toEqual(oldSealed)
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
    vault = new Vault(JSON.parse(fs.readFileSync(storeFile, 'utf8')), createSafeCodec())
    service = new BackupService(vault, directory, keyFile, save)
    await service.init()
    expect(service.status()).toMatchObject({ unlocked: true, rememberUnlock: true })
    expect(vault.exportPortable('fixed')).toEqual(expected)
  })

  it('removes the old remembered key when remember is turned off', async () => {
    keystore.available = true
    await service.unlock(current, true)
    await service.changePassword(current, next, false)
    expect(fs.existsSync(keyFile)).toBe(false)
    expect(service.status().rememberUnlock).toBe(false)
  })

  it('keeps old backups byte-for-byte, asks for the old password, and restores with it', async () => {
    const expected = vault.exportPortable('fixed'), backupFile = path.join(directory, 'old.hopline-backup')
    await service.exportTo(backupFile, null)
    const oldFile = fs.readFileSync(backupFile)
    await service.changePassword(current, next, false)
    const changed = before()
    await expect(service.importFrom(backupFile, null, 'replace')).rejects.toThrow('这个备份可能是用旧主密码加密的，请输入当时的主密码')
    expect(fs.readFileSync(storeFile)).toEqual(changed.disk)
    expect(fs.readFileSync(backupFile)).toEqual(oldFile)
    await service.importFrom(backupFile, current, 'replace')
    expect(vault.exportPortable('fixed')).toEqual(expected)
    await service.lock()
    await service.unlock(next, false)
    const newBackup = await service.auto()
    const restored = JSON.parse(Buffer.from(await decryptVault(fs.readFileSync(path.join(directory, 'backups', newBackup!)), next)).toString())
    expect(restored.hosts).toEqual(expected.hosts)
  })

  it('does not expose passwords or keys in the serialized store, logs, or diagnostics', async () => {
    const oldKey = Buffer.from(service.secretKey()!).toString('base64')
    await service.changePassword(current, next, false)
    const logs = JSON.stringify([vi.mocked(logInfo).mock.calls, vi.mocked(logError).mock.calls])
    const diagnostic = buildDiagnostics(vault.snapshot(), {}, [], logs, directory)
    const disk = fs.readFileSync(storeFile, 'utf8')
    for (const secret of [current, next, oldKey, Buffer.from(service.secretKey()!).toString('base64')]) {
      expect(disk).not.toContain(secret)
      expect(logs).not.toContain(secret)
      expect(diagnostic).not.toContain(secret)
    }
  })
})
