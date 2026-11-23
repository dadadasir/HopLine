import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vault, emptyStore, type SecretCodec } from '../src/core/vault'
import { writeJsonFile } from '../src/core/json-file'
import * as format from '../src/core/backup-format'
import { getSodium } from '../src/core/sodium'
import { BackupService } from '../src/main/backup/service'
import { createSafeCodec, setSecretKeyProvider } from '../src/main/secrets'
import * as secrets from '../src/main/secrets'

const keystore = vi.hoisted(() => ({ available: true }))
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

const password = 'test-master-password'
const legacy: SecretCodec = {
  encrypt: (value) => `plain:${Buffer.from(value).toString('base64')}`,
  decrypt: (value) => Buffer.from(value.slice(6), 'base64').toString()
}
let directory: string, storeFile: string, keyFile: string
let vault: Vault, service: BackupService, save: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  keystore.available = true
  vi.stubEnv('HOPLINE_DISABLE_KEYSTORE', '')
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-unlock-transaction-'))
  storeFile = path.join(directory, 'store.json')
  keyFile = path.join(directory, 'keys', 'remembered')
  const source = new Vault(emptyStore(), legacy)
  source.saveHost({ groupId: null, name: '旧主机', host: 'example.test', port: 22, username: 'test',
    authType: 'password', password: 'legacy-host-secret' })
  vault = new Vault(source.snapshot(), createSafeCodec())
  save = vi.fn(() => writeJsonFile(storeFile, vault.snapshot()))
  service = new BackupService(vault, path.join(directory, 'backups'), keyFile, save)
  setSecretKeyProvider(() => service.secretKey())
  save()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setSecretKeyProvider(() => null)
  fs.rmSync(directory, { recursive: true, force: true })
})

function snapshot() {
  return { data: vault.snapshot(), disk: fs.readFileSync(storeFile), status: service.status(),
    key: service.secretKey(), keyBytes: service.secretKey()?.slice(),
    remembered: fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null }
}

function expectUnchanged(previous: ReturnType<typeof snapshot>) {
  expect(vault.snapshot()).toEqual(previous.data)
  expect(fs.readFileSync(storeFile)).toEqual(previous.disk)
  expect(service.status()).toEqual(previous.status)
  expect(service.secretKey()).toBe(previous.key)
  expect(service.secretKey()).toEqual(previous.keyBytes ?? null)
  expect(fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null).toEqual(previous.remembered)
}

function migrate() {
  return vault.reencryptSecrets((value) => value.startsWith('plain:'), createSafeCodec())
}

type Failure = 'store-write' | 'store-flush' | 'store-rename' | 'key-write' | 'key-flush' | 'key-rename' | 'seal'
function fail(phase: Failure) {
  const failure = new Error(`故障注入：${phase}`)
  if (phase === 'seal') return vi.spyOn(secrets, 'sealKey').mockImplementationOnce(() => { throw failure })
  const targets = new Map<number, string>(), open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    const fd = open(...args); targets.set(fd, String(args[0])); return fd
  })
  const matches = (file: fs.PathOrFileDescriptor) => {
    const target = typeof file === 'number' ? targets.get(file) ?? '' : String(file)
    return phase.startsWith('store-') ? target === `${storeFile}.tmp` : path.basename(target) === 'next'
  }
  if (phase.endsWith('flush')) {
    const real = fs.fsyncSync
    return vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => { if (matches(fd)) throw failure; return real(fd) })
  }
  if (phase.endsWith('rename')) {
    const real = fs.renameSync
    return vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (phase === 'store-rename' ? to === storeFile : path.basename(String(from)) === 'next') throw failure
      return real(from, to)
    })
  }
  const real = fs.writeFileSync
  return vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    if (matches(file)) {
      real(file, 'partial')
      throw failure
    }
    return real(file, data, options)
  })
}

describe('setting and unlocking a master password atomically', () => {
  for (const operation of ['set', 'unlock-locked', 'unlock-open'] as const) {
    it.each<Failure>(['store-write', 'store-flush', 'store-rename', 'key-write', 'key-flush', 'key-rename', 'seal'])(
      `${operation} restores vault, keys and remembered file on %s failure`, async (phase) => {
        if (operation !== 'set') {
          await service.setPassword(password, true)
          if (operation === 'unlock-locked') await service.lock()
        }
        service.onUnlocked(migrate)
        const previous = snapshot()
        const derived: Uint8Array[] = [], subkeys: Uint8Array[] = []
        const realDerive = format.deriveBackupKey
        vi.spyOn(format, 'deriveBackupKey').mockImplementation(async (...args) => {
          const key = await realDerive(...args); derived.push(key); return key
        })
        const binaryKdf: { crypto_kdf_derive_from_key: (size: number, id: number, context: string, key: Uint8Array) => Uint8Array } = await getSodium()
        const realSubkey = binaryKdf.crypto_kdf_derive_from_key
        vi.spyOn(binaryKdf, 'crypto_kdf_derive_from_key').mockImplementation((...args) => {
          const key = realSubkey(...args); subkeys.push(key); return key
        })
        fail(phase)
        const run = () => operation === 'set' ? service.setPassword(password, true) : service.unlock(password, true)
        await expect(run()).rejects.toThrow('故障注入')
        expectUnchanged(previous)
        expect(derived.length).toBeGreaterThan(0)
        for (const key of [...derived, ...subkeys]) expect(key.every((byte) => byte === 0)).toBe(true)
        vi.restoreAllMocks()
        await run()
        expect(service.status()).toMatchObject({ unlocked: true, hasPassword: true })
        expect(vault.secretsOf(vault.listHosts()[0]!.id).password).toBe('legacy-host-secret')
      }
    )
  }

  it('restores a previously remembered key when turning remember off cannot save', async () => {
    await service.setPassword(password, true)
    const previous = snapshot()
    fail('store-rename')
    await expect(service.unlock(password, false)).rejects.toThrow('故障注入')
    expectUnchanged(previous)
  })

  it('runs legacy migration with the candidate key and rolls back listener mutations on failure', async () => {
    keystore.available = false
    service.onUnlocked(migrate)
    service.onUnlocked(() => { vault.saveGroup({ name: '不应留下' }); throw new Error('迁移失败') })
    const previous = snapshot()
    await expect(service.setPassword(password, false)).rejects.toThrow('迁移失败')
    expectUnchanged(previous)
  })

  it('saves listener migration and password settings together exactly once', async () => {
    keystore.available = false
    service.onUnlocked(migrate)
    save.mockClear()
    await service.setPassword(password, false)
    expect(save).toHaveBeenCalledTimes(1)
    expect(vault.snapshot().hosts[0]?.passwordEnc).toMatch(/^mp:/)
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf8'))).toEqual(vault.snapshot())
    await service.lock()
    await service.unlock(password, false)
    expect(vault.secretsOf(vault.listHosts()[0]!.id).password).toBe('legacy-host-secret')
  })

  it('wipes a derived key after a rejected password without disturbing an existing unlock', async () => {
    await service.setPassword(password, true)
    const previous = snapshot(), real = format.deriveBackupKey
    let rejectedKey!: Uint8Array
    vi.spyOn(format, 'deriveBackupKey').mockImplementation(async (...args) => rejectedKey = await real(...args))
    await expect(service.unlock('incorrect-password', false)).rejects.toThrow('主密码不正确')
    expectUnchanged(previous)
    expect(rejectedKey.every((byte) => byte === 0)).toBe(true)
  })

  it('rejects concurrent password operations and preserves catalog edits made during derivation after rollback', async () => {
    const real = format.deriveBackupKey
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(format, 'deriveBackupKey').mockImplementationOnce(async (...args) => { await gate; return real(...args) })
    const pending = service.setPassword(password, false)
    const rejected = expect(pending).rejects.toThrow('保存失败')
    await expect(service.setPassword('another-password', false)).rejects.toThrow('正在进行')
    await expect(service.unlock(password, false)).rejects.toThrow('正在进行')
    await expect(service.lock()).rejects.toThrow('正在进行')
    vault.saveGroup({ name: '派生期间添加' }); save()
    const previous = snapshot()
    save.mockImplementationOnce(() => { throw new Error('保存失败') })
    release()
    await rejected
    expectUnchanged(previous)
  })

  it('rolls back first-export password initialization when the store cannot be committed', async () => {
    service.onUnlocked(migrate)
    const previous = snapshot(), output = path.join(directory, 'export.hopline-backup')
    fail('store-rename')
    await expect(service.exportTo(output, password)).rejects.toThrow('故障注入')
    expectUnchanged(previous)
    expect(fs.existsSync(output)).toBe(false)
  })

  it('does not allow first-export initialization to race an explicit password setup', async () => {
    const real = format.deriveBackupKey
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(format, 'deriveBackupKey').mockImplementationOnce(async (...args) => { await gate; return real(...args) })
    const pending = service.setPassword(password, false)
    try {
      await expect(service.exportTo(path.join(directory, 'racing.hopline-backup'), 'another-password')).rejects.toThrow('正在进行')
    } finally { release(); await pending }
    await service.lock()
    await service.unlock(password, false)
    expect(service.status().unlocked).toBe(true)
  })

  it('never writes a backup under an erased key when lock starts before export in the same turn', async () => {
    await service.setPassword(password, false)
    const file = path.join(directory, 'concurrent-export.hopline-backup')
    const [locked, exported] = await Promise.allSettled([service.lock(), service.exportTo(file, null)])
    expect(locked.status).toBe('fulfilled')
    if (exported.status === 'fulfilled') {
      await expect(format.decryptVault(fs.readFileSync(file), password)).resolves.toBeInstanceOf(Uint8Array)
    } else {
      expect(exported.reason.message).toContain('解锁')
      expect(fs.existsSync(file)).toBe(false)
    }
  })

  it('never writes an automatic backup under an erased key while locking', async () => {
    await service.setPassword(password, false)
    const [, name] = await Promise.all([service.lock(), service.auto()])
    if (name) {
      const file = path.join(directory, 'backups', name)
      await expect(format.decryptVault(fs.readFileSync(file), password)).resolves.toBeInstanceOf(Uint8Array)
    } else expect(await service.listLocal()).toEqual([])
  })

  it('keeps an in-flight export decryptable after lock and wipes its temporary key', async () => {
    await service.setPassword(password, false)
    const file = path.join(directory, 'in-flight-export.hopline-backup')
    const real = format.encryptWithKey
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let usedKey!: Uint8Array
    const encrypt = vi.spyOn(format, 'encryptWithKey').mockImplementationOnce(async (plaintext, key, params) => {
      usedKey = key
      await gate
      return real(plaintext, key, params)
    })
    const pending = service.exportTo(file, null)
    try {
      expect(encrypt).toHaveBeenCalledTimes(1)
      await service.lock()
      release()
      await pending
      await expect(format.decryptVault(fs.readFileSync(file), password)).resolves.toBeInstanceOf(Uint8Array)
      expect(usedKey.every((byte) => byte === 0)).toBe(true)
    } finally { release(); await pending.catch(() => {}) }
  })

  it('clears an export key snapshot when encryption fails without damaging the held key', async () => {
    await service.setPassword(password, false)
    const previous = snapshot()
    let usedKey!: Uint8Array
    vi.spyOn(format, 'encryptWithKey').mockImplementationOnce(async (_plaintext, key) => {
      usedKey = key
      throw new Error('加密失败')
    })
    await expect(service.exportTo(path.join(directory, 'failed-export'), null)).rejects.toThrow('加密失败')
    expect(usedKey.every((byte) => byte === 0)).toBe(true)
    expectUnchanged(previous)
  })
})
