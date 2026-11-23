import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { encryptVault } from '../src/core/backup-format'
import { writeJsonFile } from '../src/core/json-file'
import { BackupService } from '../src/main/backup/service'
import { createSafeCodec, setSecretKeyProvider } from '../src/main/secrets'

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

type Source = 'local' | 'webdav'
type Mode = 'merge' | 'replace'
type Failure = 'write' | 'flush' | 'rename'
const sourcePassword = 'old-backup-password', currentPassword = 'current-master-password'
let directory: string, storeFile: string, keyFile: string, backupFile: string
let vault: Vault, service: BackupService, save: () => void
let localId: string, importedId: string

beforeEach(async () => {
  vi.stubEnv('HOPLINE_DISABLE_KEYSTORE', '')
  keystore.available = true
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-restore-transaction-'))
  storeFile = path.join(directory, 'vault.json')
  keyFile = path.join(directory, 'remembered-key')
  backupFile = path.join(directory, 'source.hopline-backup')
  vault = new Vault(emptyStore(), createSafeCodec())
  save = () => writeJsonFile(storeFile, vault.snapshot())
  service = new BackupService(vault, path.join(directory, 'backups'), keyFile, save)
  setSecretKeyProvider(() => service.secretKey())
  await service.setPassword(currentPassword, true)
  // Exercise real master-key encryption without using the OS keystore. The
  // remembered file above comes only from the in-memory safeStorage substitute.
  keystore.available = false
  const group = vault.saveGroup({ name: '当前分组' })
  localId = vault.saveHost({ groupId: group.id, name: '当前主机', host: 'current.test', port: 22, username: 'local', authType: 'password', password: 'current-host-secret' }).id
  vault.updateSettings({ theme: 'dark', fontSize: 16, webdav: { url: 'https://dav.test', username: 'local-user', password: 'current-dav-secret', remoteDir: 'hopline' } })
  save()

  const source = new Vault(emptyStore(), new MemorySecretCodec())
  const importedGroup = source.saveGroup({ name: '备份分组' })
  importedId = source.saveHost({ groupId: importedGroup.id, name: '旧备份主机', host: 'old.test', port: 22, username: 'imported', authType: 'password', password: 'imported-host-secret' }).id
  source.updateSettings({ theme: 'light', fontSize: 20, webdav: { url: 'https://old-dav.test', username: 'old-user', password: 'old-dav-secret', remoteDir: 'old' } })
  const { file } = await encryptVault(Buffer.from(JSON.stringify(source.exportPortable())), sourcePassword, { opslimit: 1, memlimit: 8192 })
  fs.writeFileSync(backupFile, file)
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'PROPFIND'
    ? new Response('<d:multistatus><d:response><d:href>/hopline/20261112000000000.hopline-backup</d:href></d:response></d:multistatus>', { status: 207 })
    : new Response(Buffer.from(file))))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  setSecretKeyProvider(() => null)
  fs.rmSync(directory, { recursive: true, force: true })
})

function restore(source: Source, mode: Mode) {
  return source === 'local' ? service.importFrom(backupFile, sourcePassword, mode) : service.webdav('pull', sourcePassword, mode)
}

function snapshot() {
  return { data: vault.snapshot(), disk: fs.readFileSync(storeFile), status: service.status(),
    key: service.secretKey(), keyBytes: service.secretKey()!.slice(), remembered: fs.readFileSync(keyFile) }
}

function expectUnchanged(before: ReturnType<typeof snapshot>) {
  expect(vault.snapshot()).toEqual(before.data)
  expect(fs.readFileSync(storeFile)).toEqual(before.disk)
  expect(service.status()).toEqual(before.status)
  expect(service.secretKey()).toBe(before.key)
  expect(service.secretKey()).toEqual(before.keyBytes)
  expect(fs.readFileSync(keyFile)).toEqual(before.remembered)
  expect(vault.secretsOf(localId).password).toBe('current-host-secret')
  expect(vault.webdavPassword()).toBe('current-dav-secret')
  expect(vault.getHost(importedId)).toBeUndefined()
}

function failSave(phase: Failure) {
  const failure = new Error(`restore-${phase}-failed`), files = new Map<number, string>()
  const open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    const fd = open(...args); files.set(fd, String(args[0])); return fd
  })
  const isTemporaryStore = (file: fs.PathOrFileDescriptor) => (typeof file === 'number' ? files.get(file) : String(file)) === `${storeFile}.tmp`
  if (phase === 'write') {
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (isTemporaryStore(file)) { write(file, 'partial'); throw failure }
      return write(file, data, options)
    })
  } else if (phase === 'flush') {
    const flush = fs.fsyncSync
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => { if (isTemporaryStore(fd)) throw failure; return flush(fd) })
  } else {
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (String(to) === storeFile) throw failure; return rename(from, to) })
  }
}

describe('backup restore commits vault changes and persistence atomically', () => {
  it.each<Mode>(['merge', 'replace'])('retains edits made while a %s download is waiting when restore later fails', async (mode) => {
    let downloaded!: (response: Response) => void, entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    const response = new Promise<Response>(resolve => { downloaded = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'PROPFIND') return new Response('<response><href>/20261112000000000.hopline-backup</href></response>', { status: 207 })
      entered(); return response
    }))
    const restoring = restore('webdav', mode)
    const rejected = expect(restoring).rejects.toThrow('restore-rename-failed')
    await reading
    const added = vault.saveHost({ groupId: null, name: '下载期间新增', host: 'later.test', port: 22, username: 'local', authType: 'password', password: 'later-host-secret' })
    vault.updateSettings({ fontSize: 18 }); save()
    const beforeCommit = snapshot()
    failSave('rename')
    downloaded(new Response(fs.readFileSync(backupFile)))
    await rejected
    expectUnchanged(beforeCommit)
    expect(vault.secretsOf(added.id).password).toBe('later-host-secret')
  })

  for (const source of ['local', 'webdav'] as const) for (const mode of ['merge', 'replace'] as const) {
    it.each<Failure>(['write', 'flush', 'rename'])(`${source} ${mode} rolls back a %s failure and a later ordinary save retains current data`, async (phase) => {
      const before = snapshot()
      failSave(phase)
      await expect(restore(source, mode)).rejects.toThrow(`restore-${phase}-failed`)
      expectUnchanged(before)
      vi.restoreAllMocks()
      // The next ordinary mutation must not accidentally commit a failed import.
      vault.updateSettings({ fontSize: 17 }); save()
      const expected = structuredClone(before.data); expected.settings.fontSize = 17
      expect(JSON.parse(fs.readFileSync(storeFile, 'utf8'))).toEqual(expected)
      const reopened = new Vault(JSON.parse(fs.readFileSync(storeFile, 'utf8')), createSafeCodec())
      expect(reopened.secretsOf(localId).password).toBe('current-host-secret')
      expect(reopened.getHost(importedId)).toBeUndefined()
    })

    it(`${source} ${mode} succeeds using the current master key without replacing its verifier or remembered file`, async () => {
      const before = snapshot()
      await restore(source, mode)
      expect(JSON.parse(fs.readFileSync(storeFile, 'utf8'))).toEqual(vault.snapshot())
      expect(vault.getHost(importedId)).toBeDefined()
      expect(vault.getHost(localId) !== undefined).toBe(mode === 'merge')
      expect(vault.secretsOf(importedId).password).toBe('imported-host-secret')
      expect(vault.webdavPassword()).toBe('old-dav-secret')
      expect(vault.snapshot().hosts.find(host => host.id === importedId)?.passwordEnc).toMatch(/^mp:/)
      expect(vault.snapshot().settings).toMatchObject({ theme: 'light', fontSize: 20 })
      expect(vault.kdf()).toEqual(before.data.settings.backup.kdf)
      expect(vault.verifier()).toBe(before.data.settings.backup.verifier)
      expect(service.secretKey()).toBe(before.key)
      expect(service.secretKey()).toEqual(before.keyBytes)
      expect(fs.readFileSync(keyFile)).toEqual(before.remembered)
    })
  }
})
