import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupService } from '../src/main/backup/service'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { decryptVault, encryptVault } from '../src/core/backup-format'
import { getSodium } from '../src/core/sodium'
import { emptyHostMeta } from '../src/core/host-meta'
import { BACKUP_VERSION } from '../src/core/backup-format'

vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('../src/main/secrets', () => ({ sealKey: (key: Uint8Array) => Buffer.from(key), openKey: (key: Buffer) => key }))

let directory: string
let vault: Vault
let service: BackupService
const password = 'master-password'

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-backup-'))
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  service = new BackupService(vault, path.join(directory, 'backup'), path.join(directory, 'keys', 'backup-key.bin'), vi.fn())
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})

async function setupPassword(remember = false) {
  const { file, params } = await encryptVault(Buffer.from('hopline-vault-ok'), password, { opslimit: 1, memlimit: 8192 })
  vault.setBackupUnlock({ ...params, salt: Buffer.from(params.salt).toString('base64') }, Buffer.from(file).toString('base64'))
  await service.unlock(password, remember)
}

function configureWebdav() {
  vault.updateSettings({ webdav: { url: 'https://dav.test', username: 'u', password: 'p', remoteDir: 'hopline' } })
}

describe('backup service safety', () => {
  it('imports a v1 portable payload through the versioned backup container', async () => {
    const payload = {
      kind: 'hopline-vault', version: 1, exportedAt: '',
      groups: [{ id: 'legacy-group', name: '旧组', sortOrder: 0 }],
      hosts: [{ id: 'legacy-host', name: '旧主机', host: 'legacy.test', port: 22, username: 'u', authType: 'password', password: 'legacy-secret', groupId: 'legacy-group', createdAt: 1, updatedAt: 2 }],
      settings: { theme: 'dark' }
    }
    const { file } = await encryptVault(Buffer.from(JSON.stringify(payload)), password, { opslimit: 1, memlimit: 8192 })
    const filePath = path.join(directory, 'legacy.hopline-backup')
    fs.writeFileSync(filePath, file)
    expect(BACKUP_VERSION).toBe(2)
    await service.importFrom(filePath, password, 'replace')
    expect(vault.getHost('legacy-host')?.meta).toEqual(emptyHostMeta())
    expect(vault.getHost('legacy-host')).toMatchObject({ connectionTimeoutSec: null, keepaliveIntervalSec: null, createdAt: 1, updatedAt: 2 })
    expect(vault.secretsOf('legacy-host').password).toBe('legacy-secret')
    expect(vault.snapshot().groups[0]).toMatchObject({ id: 'legacy-group', deletedAt: null })
    expect(vault.exportPortable().version).toBe(8)
  })

  it.each(['merge', 'replace'] as const)('imports encrypted v7 connection defaults through %s without changing record timestamps', async (mode) => {
    const source = new Vault(emptyStore(), new MemorySecretCodec())
    const host = source.saveHost({ name: '旧参数', host: 'legacy.test', username: 'u', port: 22, groupId: null, authType: 'password', password: 'legacy-secret' })
    const exported = source.exportPortable('fixed')
    const payload = { ...exported, version: 7, hosts: exported.hosts.map(({ connectionTimeoutSec: _timeout, keepaliveIntervalSec: _keepalive, ...record }) => record) }
    const { file } = await encryptVault(Buffer.from(JSON.stringify(payload)), password, { opslimit: 1, memlimit: 8192 })
    const filePath = path.join(directory, 'legacy-v7.hopline-backup')
    fs.writeFileSync(filePath, file)
    const local = vault.saveHost({ name: '本地', host: 'local.test', username: 'u', port: 22, groupId: null, authType: 'password', connectionTimeoutSec: 120, keepaliveIntervalSec: 0 })
    await service.importFrom(filePath, password, mode)
    expect(vault.getHost(host.id)).toMatchObject({ connectionTimeoutSec: null, keepaliveIntervalSec: null, createdAt: host.createdAt, updatedAt: host.updatedAt })
    expect(vault.secretsOf(host.id).password).toBe('legacy-secret')
    if (mode === 'merge') expect(vault.getHost(local.id)).toMatchObject({ connectionTimeoutSec: 120, keepaliveIntervalSec: 0 })
    else expect(vault.getHost(local.id)).toBeUndefined()
    expect(vault.exportPortable().version).toBe(8)
  })

  it('round-trips v8 connection settings, assets and tombstones through the unchanged v2 binary format', async () => {
    await setupPassword()
    const host = vault.saveHost({ name: '资产', host: 'asset.test', username: 'u', port: 22, groupId: null, authType: 'password', connectionTimeoutSec: 120, keepaliveIntervalSec: 0, meta: { provider: '厂商', currency: 'CNY', price: 100, billingCycle: 'monthly', tags: ['测试'] } })
    const group = vault.saveGroup({ name: '删除' })
    vault.deleteGroup(group.id)
    const deleted = vault.duplicateHost(host.id)
    vault.deleteHost(deleted.id)
    vault.saveHost({ name: 'Agent', host: 'agent.test', username: 'u', port: 22, groupId: null, authType: 'agent',
      agent: { socket: '~/custom.sock', identityFile: '~/.ssh/key.pub', forward: true },
      jumps: [{ host: 'jump.test', port: 22, username: 'j', authType: 'agent' }]
    })
    const expected = vault.exportPortable('fixed')
    const filePath = path.join(directory, 'v2.hopline-backup')
    await service.exportTo(filePath, null)
    const bytes = fs.readFileSync(filePath)
    expect(bytes[7]).toBe(2)
    expect(JSON.parse(Buffer.from(await decryptVault(bytes, password)).toString())).toMatchObject({ version: 8, hosts: expect.arrayContaining([expect.objectContaining({ id: host.id, connectionTimeoutSec: 120, keepaliveIntervalSec: 0 })]) })
    const restored = new Vault(emptyStore(), new MemorySecretCodec())
    const backup = new BackupService(restored, path.join(directory, 'other'), path.join(directory, 'other-key'), vi.fn())
    await backup.importFrom(filePath, password, 'replace')
    expect(restored.exportPortable('fixed')).toEqual(expected)
  })

  it.each(['merge', 'replace'] as const)('rejects invalid v8 connection settings in an encrypted %s without altering local data', async (mode) => {
    vault.saveHost({ name: '保留', host: 'keep.test', username: 'u', port: 22, groupId: null, authType: 'password', password: 'unchanged', connectionTimeoutSec: 20, keepaliveIntervalSec: 0 })
    const before = vault.snapshot()
    const payload = vault.exportPortable()
    payload.hosts[0]!.connectionTimeoutSec = 121
    payload.hosts[0]!.name = '不应保存'
    const { file } = await encryptVault(Buffer.from(JSON.stringify(payload)), password, { opslimit: 1, memlimit: 8192 })
    const filePath = path.join(directory, 'bad-v8.hopline-backup')
    fs.writeFileSync(filePath, file)
    await expect(service.importFrom(filePath, password, mode)).rejects.toThrow('连接超时必须是 5 到 120 秒的整数')
    expect(vault.snapshot()).toEqual(before)
  })

  it.each([
    [1000, 8192], [1, 2 ** 40], [0, 8192], [1, 8191], [1.5, 8192], [1, NaN]
  ])('rejects local KDF values %s/%s before deriving', async (opslimit, memlimit) => {
    vault.setBackupUnlock({ opslimit, memlimit, salt: Buffer.alloc(16).toString('base64') }, 'verifier')
    const sodium = await getSodium()
    const derive = vi.spyOn(sodium, 'crypto_pwhash').mockImplementation(() => { throw new Error('不应派生密钥') })
    await expect(service.unlock(password, false)).rejects.toThrow('备份文件参数异常')
    expect(derive).not.toHaveBeenCalled()
  })

  it.each(['20261027000000', '20261027000000001', '20261027000000000'])('pulls the newest timestamp %s among both filename formats', async (latest) => {
    configureWebdav()
    const payload = vault.exportPortable()
    payload.groups = [{ id: 'restored', name: '最新备份', sortOrder: 0, updatedAt: Date.now() }]
    const { file } = await encryptVault(Buffer.from(JSON.stringify(payload)), password, { opslimit: 1, memlimit: 8192 })
    const names = ['20261026000000999', '20261025000000', latest, 'zzz', '2026102800000000']
    if (latest.endsWith('001')) names.push('20261027000000')
    const xml = names.map((name, i) => `<d:response><d:href>/hopline/${name}.hopline-backup</d:href><d:getlastmodified>${i === 0 ? 'Wed, 28 Oct 2026' : 'Mon, 26 Oct 2026'}</d:getlastmodified></d:response>`).join('')
    const fetch = vi.fn().mockImplementation((_url, init) => Promise.resolve(
      init.method === 'PROPFIND' ? new Response(xml, { status: 207 }) : new Response(Buffer.from(file))
    ))
    vi.stubGlobal('fetch', fetch)
    await service.webdav('pull', password, 'replace')
    expect(fetch.mock.calls[1]?.[0]).toBe(`https://dav.test/hopline/${latest}.hopline-backup`)
    expect(vault.listGroups()[0]?.name).toBe('最新备份')
  })

  it('rejects listings without a valid backup name', async () => {
    configureWebdav()
    const fetch = vi.fn().mockResolvedValue(new Response('<response><href>/x.hopline-backup</href></response>', { status: 207 }))
    vi.stubGlobal('fetch', fetch)
    await expect(service.webdav('pull', password, 'replace')).rejects.toThrow('WebDAV 上还没有 Hopline 备份')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('uses UTC names for simultaneous auto backups and keeps them private', async () => {
    await setupPassword()
    vi.useFakeTimers().setSystemTime(new Date('2026-10-27T12:00:00.123Z'))
    const names = await Promise.all([service.auto(), service.auto()])
    expect(new Set(names).size).toBe(2)
    for (const name of names) {
      expect(name).toMatch(/^20261027120000\d{3}\.hopline-backup$/)
      const filePath = path.join(directory, 'backup', name!)
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
      expect(JSON.parse(Buffer.from(await decryptVault(fs.readFileSync(filePath), password)).toString()).kind).toBe('hopline-vault')
    }
    expect(fs.statSync(path.join(directory, 'backup')).mode & 0o777).toBe(0o700)
    expect(await service.listLocal()).toHaveLength(2)
  })

  it('keeps UTC backup names ordered through daylight saving rollback', async () => {
    await setupPassword()
    vi.useFakeTimers().setSystemTime(new Date('2026-11-01T08:30:00.000Z'))
    const before = await service.auto()
    vi.setSystemTime(new Date('2026-11-01T09:30:00.000Z'))
    const after = await service.auto()
    expect(before).toBe('20261101083000000.hopline-backup')
    expect(after).toBe('20261101093000000.hopline-backup')
  })

  it('preserves an existing automatic backup when its timestamp collides', async () => {
    await setupPassword()
    vi.useFakeTimers().setSystemTime(new Date('2026-10-27T12:00:00.123Z'))
    fs.mkdirSync(path.join(directory, 'backup'))
    const existing = path.join(directory, 'backup', '20261027120000123.hopline-backup')
    fs.writeFileSync(existing, 'existing backup')
    expect(await service.auto()).toBe('20261027120000124.hopline-backup')
    expect(fs.readFileSync(existing, 'utf8')).toBe('existing backup')
  })

  it('uses UTC names for WebDAV and keeps successive pushes distinct', async () => {
    await setupPassword()
    configureWebdav()
    vi.useFakeTimers().setSystemTime(new Date('2026-10-27T12:00:00.123Z'))
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    await service.webdav('push', null, 'merge')
    await service.webdav('push', null, 'merge')
    const urls = fetch.mock.calls.filter(([, init]) => init.method === 'PUT').map(([url]) => url)
    expect(new Set(urls).size).toBe(2)
    expect(urls).toEqual(['https://dav.test/hopline/20261027120000123.hopline-backup', 'https://dav.test/hopline/20261027120000124.hopline-backup'])
  })

  it('writes exported backups and remembered keys with private permissions, including existing files', async () => {
    const keyFile = path.join(directory, 'keys', 'backup-key.bin')
    await setupPassword(true)
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(keyFile)).mode & 0o777).toBe(0o700)
    fs.chmodSync(keyFile, 0o644)
    await service.unlock(password, true)
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
    const exportFile = path.join(directory, 'export', 'manual.hopline-backup')
    await service.exportTo(exportFile, null)
    expect(fs.statSync(path.dirname(exportFile)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(exportFile).mode & 0o777).toBe(0o600)
    fs.chmodSync(exportFile, 0o644)
    await service.exportTo(exportFile, null)
    expect(fs.statSync(exportFile).mode & 0o777).toBe(0o600)
  })
})
