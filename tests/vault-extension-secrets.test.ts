import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { migrateStore } from '../src/core/vault-migrate'
import { readStoreFile } from '../src/core/store-file'
import { writeJsonFile } from '../src/core/json-file'
import { BackupService } from '../src/main/backup/service'
import { createSafeCodec, setSecretKeyProvider } from '../src/main/secrets'
import { buildDiagnostics } from '../src/main/diagnostics'

const keystore = vi.hoisted(() => ({ available: false }))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => keystore.available,
  encryptString: (text: string) => Buffer.from(`test-box:${text}`),
  decryptString: (bytes: Buffer) => bytes.toString().slice('test-box:'.length)
} }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('../src/core/backup-format', async (original) => {
  const actual = await original<typeof import('../src/core/backup-format')>()
  return { ...actual, createKdfParams: () => actual.createKdfParams({ opslimit: 1, memlimit: 8192 }) }
})

let directory: string, file: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-extension-secrets-'))
  file = path.join(directory, 'store.json')
  keystore.available = false
  vi.stubEnv('HOPLINE_DISABLE_KEYSTORE', '')
  setSecretKeyProvider(() => null)
})
afterEach(() => {
  setSecretKeyProvider(() => null)
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})
const create = () => new Vault(emptyStore(), new MemorySecretCodec())
const host = { name: '主机', host: '127.0.0.1', username: 'test', port: 22, authType: 'password' as const, groupId: null }

describe('generic local extension credentials', () => {
  it('isolates owners and slots, encrypts values, removes empty owners, and survives disk reload', () => {
    const vault = create()
    expect(vault.extensionSecretHas('first', 'channel')).toBe(false)
    expect(vault.extensionSecretGet('first', 'channel')).toBeNull()
    vault.extensionSecretSet('first', 'channel', 'first-secret')
    vault.extensionSecretSet('second', 'channel', 'second-secret')
    vault.extensionSecretSet('first', 'other', 'other-secret')
    expect(vault.extensionSecretGet('first', 'channel')).toBe('first-secret')
    expect(vault.extensionSecretGet('second', 'channel')).toBe('second-secret')
    expect(JSON.stringify(vault.snapshot())).not.toContain('first-secret')
    writeJsonFile(file, vault.snapshot())
    const loaded = readStoreFile(file)
    expect(loaded.hadRejectedRecords).toBe(false)
    const restored = new Vault(loaded.data, new MemorySecretCodec())
    expect(restored.extensionSecretGet('first', 'other')).toBe('other-secret')
    restored.extensionSecretSet('first', 'channel', null)
    restored.extensionSecretSet('first', 'other', null)
    expect(restored.snapshot().localExtensionSecrets).not.toHaveProperty('first')
    expect(restored.extensionSecretGet('second', 'channel')).toBe('second-secret')
  })

  it.each(['', '__proto__', 'constructor', 'prototype', '../escape', 'UPPER', 'with space', 'a'.repeat(65), null, 1])('rejects unsafe owner and slot %j without mutation', name => {
    const vault = create(), before = vault.snapshot()
    for (const args of [[name, 'slot'], ['owner', name]]) {
      expect(() => vault.extensionSecretHas(args[0] as string, args[1] as string)).toThrow('凭据名称')
      expect(() => vault.extensionSecretGet(args[0] as string, args[1] as string)).toThrow('凭据名称')
      expect(() => vault.extensionSecretSet(args[0] as string, args[1] as string, 'value')).toThrow('凭据名称')
    }
    expect(vault.snapshot()).toEqual(before)
  })

  it('bounds UTF-8 values and keeps the old secret on encryption or save failure', () => {
    const codec = new MemorySecretCodec(), vault = new Vault(emptyStore(), codec)
    vault.extensionSecretSet('owner', 'slot', 'initial')
    const before = vault.snapshot()
    expect(() => vault.extensionSecretSet('owner', 'slot', '你'.repeat(22_000))).toThrow('凭据内容')
    expect(() => vault.extensionSecretSet('owner', 'slot', undefined as never)).toThrow('凭据内容')
    const encrypt = vi.spyOn(codec, 'encrypt').mockImplementation(() => { throw new Error('cipher unavailable') })
    expect(() => vault.extensionSecretSet('owner', 'slot', 'replacement')).toThrow('cipher unavailable')
    expect(vault.snapshot()).toEqual(before)
    encrypt.mockRestore()
    writeJsonFile(file, before)
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('disk full') })
    expect(() => vault.transaction(() => { vault.extensionSecretSet('owner', 'slot', 'replacement'); writeJsonFile(file, vault.snapshot()) })).toThrow('disk full')
    expect(vault.snapshot()).toEqual(before)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before)
  })

  it.each(['merge', 'replace'] as const)('excludes credentials from portable v8 and preserves local slots during %s, including hostile input', mode => {
    const local = create(), incoming = create()
    local.extensionSecretSet('first', 'slot', 'local-secret')
    incoming.extensionSecretSet('first', 'slot', 'incoming-secret')
    incoming.saveHost(host)
    const exported = incoming.exportPortable()
    expect(exported.version).toBe(8)
    expect(JSON.stringify(exported)).not.toContain('localExtensionSecrets')
    expect(JSON.stringify(exported)).not.toContain('incoming-secret')
    local.importPortable({ ...exported, localExtensionSecrets: incoming.snapshot().localExtensionSecrets } as never, mode)
    expect(local.extensionSecretGet('first', 'slot')).toBe('local-secret')
    expect(local.listHosts()).toHaveLength(1)
    expect(local.settingsPublic(false)).not.toHaveProperty('localExtensionSecrets')
  })

  it('keeps extension ciphertext out of diagnostic output', () => {
    const vault = create()
    vault.extensionSecretSet('first', 'slot', 'private-extension-value')
    const ciphertext = vault.snapshot().localExtensionSecrets.first.slot.valueEnc
    const report = buildDiagnostics(vault.snapshot(), {}, [ciphertext], `log ${ciphertext}`, '')
    expect(report).not.toContain(ciphertext)
    expect(report).not.toContain('private-extension-value')
    expect(report).toContain('[REDACTED]')
  })
})

describe('v9 local storage and background preference', () => {
  it('upgrades v8 without changing host records or input, adding only local slots and the default preference', () => {
    const vault = create(); vault.saveHost(host)
    const current = vault.snapshot()
    const { localExtensionSecrets: _, ...old } = current
    const { backgroundStay: __, ...settings } = old.settings
    const legacy = { ...old, version: 8, settings }, original = structuredClone(legacy)
    const result = migrateStore(legacy)
    expect(result).toEqual({ data: current, migratedFrom: 8 })
    expect(legacy).toEqual(original)
    writeJsonFile(file, legacy)
    expect(readStoreFile(file)).toEqual({ data: current, migratedFrom: 8, hadRejectedRecords: false })
  })

  it('preserves malformed credential records privately without dropping valid hosts or slots', () => {
    const vault = create(); vault.saveHost(host); vault.extensionSecretSet('owner', 'good', 'retained')
    const source = vault.snapshot()
    const bad = { valueEnc: 3 }, invalidOwner = { slot: { valueEnc: 'mp:QQ==' } }
    const sourceSecrets = JSON.parse(JSON.stringify({ ...source.localExtensionSecrets, owner: { ...source.localExtensionSecrets.owner, bad }, '../bad': invalidOwner }))
    Object.defineProperty(sourceSecrets, '__proto__', { enumerable: true, value: invalidOwner })
    writeJsonFile(file, { ...source, localExtensionSecrets: sourceSecrets })
    const logger = vi.fn(), result = readStoreFile(file, logger)
    expect(result.data).toEqual(source)
    expect(result.hadRejectedRecords).toBe(true)
    const rejected = fs.readdirSync(directory).find(name => name.includes('.rejected-'))!
    expect(fs.statSync(path.join(directory, rejected)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(path.join(directory, rejected), 'utf8'))).toEqual({ hosts: [], groups: [], localExtensionSecrets: [
      { owner: 'owner', slot: 'bad', value: bad }, { owner: '../bad', value: invalidOwner }, { owner: '__proto__', value: invalidOwner }
    ] })
    expect(JSON.stringify(logger.mock.calls)).not.toContain('valueEnc')
  })

  it('leaves the original file intact if malformed credential preservation fails', () => {
    const raw = { ...emptyStore(), localExtensionSecrets: { owner: { invalid: { valueEnc: false } } } }
    writeJsonFile(file, raw)
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('disk full') })
    expect(() => readStoreFile(file, vi.fn())).toThrow('无法保留异常记录')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(raw)
  })

  it('round-trips false through public settings, disk and portable data; old backups default to true', () => {
    const vault = create()
    expect(vault.settingsPublic(false).backgroundStay).toBe(true)
    vault.updateSettings({ backgroundStay: false })
    expect(vault.settingsPublic(false).backgroundStay).toBe(false)
    writeJsonFile(file, vault.snapshot())
    expect(readStoreFile(file).data.settings.backgroundStay).toBe(false)
    const portable = vault.exportPortable(), restored = create()
    expect(portable.settings.backgroundStay).toBe(false)
    restored.importPortable(portable, 'replace')
    expect(restored.settingsPublic(false).backgroundStay).toBe(false)
    delete portable.settings.backgroundStay
    restored.importPortable(portable, 'merge')
    expect(restored.settingsPublic(false).backgroundStay).toBe(true)
    const before = restored.snapshot()
    expect(() => restored.updateSettings({ language: 'en', backgroundStay: 'false' as never })).toThrow('常驻设置')
    expect(restored.snapshot()).toEqual(before)
  })
})

describe('existing credential protection and master-password rotation', () => {
  async function setup() {
    const vault = new Vault(emptyStore(), createSafeCodec())
    const save = vi.fn(() => writeJsonFile(file, vault.snapshot()))
    const service = new BackupService(vault, path.join(directory, 'backup'), path.join(directory, 'remembered'), save)
    setSecretKeyProvider(() => service.secretKey())
    await service.setPassword('old-master-password', false)
    return { vault, save, service }
  }

  it('uses OS encryption when available and does not silently fall back while a master key is locked', async () => {
    keystore.available = true
    const vault = new Vault(emptyStore(), createSafeCodec())
    vault.extensionSecretSet('owner', 'slot', 'private-value')
    expect(vault.snapshot().localExtensionSecrets.owner.slot.valueEnc).toMatch(/^safe:/)
    expect(vault.extensionSecretGet('owner', 'slot')).toBe('private-value')
    keystore.available = false
    expect(() => vault.extensionSecretSet('owner', 'new', 'value')).toThrow('主密码')
    expect(vault.extensionSecretHas('owner', 'new')).toBe(false)
    const { vault: encrypted, service } = await setup()
    encrypted.extensionSecretSet('owner', 'slot', 'private-value')
    expect(encrypted.snapshot().localExtensionSecrets.owner.slot.valueEnc).toMatch(/^mp:/)
    await service.lock()
    expect(encrypted.extensionSecretHas('owner', 'slot')).toBe(true)
    expect(() => encrypted.extensionSecretGet('owner', 'slot')).toThrow('主密码')
    expect(() => encrypted.extensionSecretSet('owner', 'slot', 'changed')).toThrow('主密码')
    await service.unlock('old-master-password', false)
    expect(encrypted.extensionSecretGet('owner', 'slot')).toBe('private-value')
  })

  it('rotates local credentials in the same save as host credentials and unlocks after restart with the new password only', async () => {
    const { vault, save, service } = await setup()
    vault.saveHost({ ...host, password: 'host-secret' })
    vault.extensionSecretSet('owner', 'slot', 'extension-secret')
    save(); save.mockClear()
    const before = vault.snapshot()
    await service.changePassword('old-master-password', 'new-master-password', false)
    expect(save).toHaveBeenCalledOnce()
    expect(vault.snapshot().localExtensionSecrets.owner.slot.valueEnc).not.toBe(before.localExtensionSecrets.owner.slot.valueEnc)
    expect(vault.snapshot().hosts[0].passwordEnc).not.toBe(before.hosts[0].passwordEnc)
    const restored = new Vault(readStoreFile(file).data, createSafeCodec())
    const restarted = new BackupService(restored, directory, path.join(directory, 'remembered'), vi.fn())
    setSecretKeyProvider(() => restarted.secretKey())
    await expect(restarted.unlock('old-master-password', false)).rejects.toThrow('主密码不正确')
    await restarted.unlock('new-master-password', false)
    expect(restored.extensionSecretGet('owner', 'slot')).toBe('extension-secret')
    expect(restored.secretsOf(restored.listHosts()[0].id).password).toBe('host-secret')
  })

  it('rolls all local credentials and held keys back when rotation persistence fails', async () => {
    const { vault, save, service } = await setup()
    vault.extensionSecretSet('owner', 'slot', 'extension-secret'); save()
    const before = vault.snapshot(), disk = fs.readFileSync(file), key = service.secretKey()!.slice()
    save.mockImplementation(() => { throw new Error('disk full') })
    await expect(service.changePassword('old-master-password', 'new-master-password', false)).rejects.toThrow('disk full')
    expect(vault.snapshot()).toEqual(before)
    expect(fs.readFileSync(file)).toEqual(disk)
    expect(service.secretKey()).toEqual(key)
    expect(vault.extensionSecretGet('owner', 'slot')).toBe('extension-secret')
  })

  it('migrates local legacy ciphertext through the same staged re-encryption path without touching unrelated slots', async () => {
    const { vault } = await setup(), source = vault.snapshot()
    source.localExtensionSecrets = { owner: { old: { valueEnc: `plain:${Buffer.from('old-value').toString('base64')}` } } }
    vault.replace(source)
    vault.extensionSecretSet('owner', 'current', 'current-value')
    const current = vault.snapshot().localExtensionSecrets.owner.current.valueEnc
    expect(vault.reencryptSecrets(value => value.startsWith('plain:'), createSafeCodec())).toBe(1)
    expect(vault.extensionSecretGet('owner', 'old')).toBe('old-value')
    expect(vault.snapshot().localExtensionSecrets.owner.old.valueEnc).toMatch(/^mp:/)
    expect(vault.snapshot().localExtensionSecrets.owner.current.valueEnc).toBe(current)
  })
})
