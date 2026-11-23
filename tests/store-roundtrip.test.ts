import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault, type PortableVaultV1 } from '../src/core/vault'
import { readStoreFile } from '../src/core/store-file'
import { writeJsonFile } from '../src/core/json-file'

let directory: string
let filePath: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-roundtrip-'))
  filePath = path.join(directory, 'hopline-store.json')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  fs.rmSync(directory, { recursive: true, force: true })
})
const hostInput = { name: 'edge', host: 'example.test', port: 22, username: 'u', authType: 'password' as const, groupId: null }
const minimalHost = { id: 'imported', name: 'minimal', host: 'minimal.test', port: 22, username: 'u', authType: 'password' }
function portable(groups: unknown[] = []): PortableVaultV1 {
  return { kind: 'hopline-vault', version: 1, exportedAt: '', groups, hosts: [{ ...minimalHost,
    proxy: { type: 'socks5', host: 'proxy.test', port: 1080 },
    jump: { host: 'jump.test', port: 22, username: 'j', authType: 'privateKey' }
  }], settings: {} } as unknown as PortableVaultV1
}

describe('store compatibility', () => {
  it('keeps imported v2 tombstones through disk normalization and re-export', () => {
    const source = new Vault(emptyStore(), new MemorySecretCodec())
    const group = source.saveGroup({ name: '删除分组' })
    const host = source.saveHost({ ...hostInput, password: 'secret', meta: { currency: 'CNY', price: 123, billingCycle: 'monthly', tags: ['资产'] } })
    source.duplicateHost(host.id)
    source.deleteHost(host.id)
    source.deleteGroup(group.id)
    const exported = source.exportPortable('fixed')
    const target = new Vault(emptyStore(), new MemorySecretCodec())
    target.importPortable(exported, 'replace')
    writeJsonFile(filePath, target.snapshot())
    const loaded = readStoreFile(filePath)
    expect(loaded.hadRejectedRecords).toBe(false)
    expect(loaded.data).toEqual(target.snapshot())
    expect(new Vault(loaded.data, new MemorySecretCodec()).exportPortable('fixed')).toEqual(exported)
    expect(fs.readdirSync(directory)).toEqual(['hopline-store.json'])
  })

  describe.each(['merge', 'replace'] as const)('atomic portable %s', (mode) => {
    it.each([
      ['jump', { host: 'jump.test', username: 'j', authType: 'password' }, '跳板', '端口'],
      ['jump', { port: 22, username: 'j', authType: 'password' }, '跳板', '主机'],
      ['jump', { host: 'jump.test', port: 22, authType: 'password' }, '跳板', '用户'],
      ['proxy', { type: 'socks5', port: 1080 }, '代理', '主机'],
      ['proxy', { type: 'http', host: 'proxy.test' }, '代理', '端口']
    ])('rejects invalid %s with host context and leaves the entire vault unchanged', (field, connection, label, detail) => {
      const vault = new Vault(emptyStore(), new MemorySecretCodec())
      const existingGroup = vault.saveGroup({ name: 'original group' })
      const existingHost = vault.saveHost({ ...hostInput, groupId: existingGroup.id, password: 'secret' })
      vault.updateSettings({ theme: 'dark' })
      const before = vault.snapshot()
      writeJsonFile(filePath, before)
      const payload = portable([{ id: existingGroup.id, name: 'changed group' }, { id: 'new-group', name: 'new group' }])
      const valid = { ...payload.hosts[0]!, id: existingHost.id, name: 'changed host' }
      const invalid = { ...payload.hosts[0]!, name: 'broken-host', [field as string]: connection }
      payload.hosts = [valid, invalid]
      expect(() => vault.importPortable(payload, mode)).toThrow(new RegExp(`broken-host.*${label}.*${detail}`))
      expect(vault.snapshot()).toEqual(before)
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(before)
    })

    it('validates and normalizes proxy and jump fields before a lossless disk round-trip', () => {
      const vault = new Vault(emptyStore(), new MemorySecretCodec())
      const payload = portable()
      payload.hosts[0]!.proxy!.host = '  proxy.test  '
      payload.hosts[0]!.jump!.host = '  jump.test  '
      payload.hosts[0]!.jump!.username = '  j  '
      vault.importPortable(payload, mode)
      expect(vault.snapshot().hosts[0]).toMatchObject({ proxy: { host: 'proxy.test', port: 1080 }, jumps: [{ host: 'jump.test', port: 22, username: 'j' }] })
      writeJsonFile(filePath, vault.snapshot())
      expect(readStoreFile(filePath, vi.fn()).data).toEqual(vault.snapshot())
      expect(fs.readdirSync(directory)).toEqual(['hopline-store.json'])
    })
  })

  it('round-trips every Vault write path without quarantining records', () => {
    const vault = new Vault(emptyStore(), new MemorySecretCodec())
    const log = vi.fn()
    const roundTrip = () => {
      const expected = vault.snapshot()
      writeJsonFile(filePath, expected)
      const { data: loaded, hadRejectedRecords } = readStoreFile(filePath, log)
      expect(loaded.hosts).toHaveLength(expected.hosts.length)
      expect(loaded.groups).toHaveLength(expected.groups.length)
      expect(loaded).toEqual(expected)
      expect(fs.readdirSync(directory)).toEqual(['hopline-store.json'])
      expect(log).not.toHaveBeenCalled()
      expect(hadRejectedRecords).toBe(false)
      vault.replace(loaded)
    }
    const first = vault.saveGroup({ name: 'first' })
    roundTrip()
    const second = vault.saveGroup({ name: 'second' })
    roundTrip()
    vault.saveGroup({ id: first.id, name: 'renamed' })
    roundTrip()
    const host = vault.saveHost({ ...hostInput, groupId: first.id, password: 'secret',
      proxy: { type: 'socks5', host: 'proxy.test', port: 1080, password: 'proxy-secret' },
      jumps: [{ host: 'jump.test', port: 22, username: 'j', authType: 'privateKey', privateKey: 'key' }]
    })
    roundTrip()
    vault.saveHost({ ...hostInput, id: host.id, groupId: first.id, name: 'edited', startupCommand: 'pwd' })
    roundTrip()
    const copy = vault.duplicateHost(host.id)
    roundTrip()
    vault.moveGroup(second.id, -1)
    roundTrip()
    vault.deleteGroup(first.id)
    roundTrip()
    vault.deleteHost(copy.id)
    roundTrip()
    vault.updateSettings({ language: 'en', theme: 'dark', fontSize: 16, transferConcurrency: 5,
      packSmallFiles: false, sidebarCollapsed: true, rememberUnlock: false,
      webdav: { url: 'https://dav.test', username: 'u', password: 'dav-secret', remoteDir: 'hopline' },
      s3: { endpoint: 'https://s3.test', bucket: 'backup', region: 'auto', accessKeyId: 'key', secretAccessKey: 'secret', prefix: 'hopline', forcePathStyle: true }
    })
    roundTrip()
    vault.setBackupUnlock({ opslimit: 1, memlimit: 8192, salt: Buffer.alloc(16).toString('base64') }, 'verifier')
    roundTrip()
    vault.markAutoBackup(123456)
    roundTrip()
    vault.importPortable(portable([{ id: second.id, name: 'imported group' }]), 'merge')
    roundTrip()
    expect(vault.snapshot().hosts).toHaveLength(3)
    expect(vault.listHosts()).toHaveLength(2)
    expect(vault.listGroups()[0]?.sortOrder).toBe(0)
    vault.importPortable(portable(), 'replace')
    roundTrip()
    expect(vault.snapshot().hosts).toHaveLength(1)
    expect(vault.snapshot().hosts[0]).toMatchObject({ groupId: null, privateKeyPath: null, startupCommand: null, proxy: { username: null }, jumps: [{ privateKeyPath: null }] })
  })

  it('repairs old records with missing nullable fields without isolating the store', () => {
    writeJsonFile(filePath, { version: 1, hosts: [{ ...minimalHost, createdAt: 1, updatedAt: 2,
      proxy: { type: 'http', host: 'proxy.test', port: 1080 },
      jump: { host: 'jump.test', port: 22, username: 'j', authType: 'privateKey' }
    }], groups: [{ id: 'g', name: 'group' }] })
    const log = vi.fn()
    const { data: loaded, hadRejectedRecords } = readStoreFile(filePath, log)
    expect(loaded.hosts[0]).toMatchObject({ ...minimalHost, groupId: null, privateKeyPath: null, startupCommand: null,
      passwordEnc: null, privateKeyEnc: null, passphraseEnc: null,
      proxy: { username: null, passwordEnc: null },
      jumps: [{ privateKeyPath: null, passwordEnc: null, privateKeyEnc: null, passphraseEnc: null }]
    })
    expect(loaded.groups[0]?.sortOrder).toBe(0)
    expect(fs.readdirSync(directory)).toEqual(['hopline-store.json'])
    expect(log).not.toHaveBeenCalled()
    expect(hadRejectedRecords).toBe(false)
  })

  it.each([42, null, { theme: 'invalid', language: 3, fontSize: 100, transferConcurrency: -1, packSmallFiles: 'yes', sidebarCollapsed: [], backup: 42 },
    { backup: { rememberUnlock: 'yes', kdf: { opslimit: 1000, memlimit: 8192, salt: 'x' }, verifier: 23, webdav: false, s3: [], lastAutoBackupAt: 'yesterday' } }
  ])('defaults invalid settings without rejecting valid hosts: %j', (settings) => {
    writeJsonFile(filePath, { version: 1, hosts: [minimalHost], groups: [], settings })
    const { data: loaded } = readStoreFile(filePath, vi.fn())
    expect(loaded.hosts).toHaveLength(1)
    expect(loaded.settings).toEqual(emptyStore().settings)
    expect(fs.readdirSync(directory)).toEqual(['hopline-store.json'])
  })

  it('preserves rejected raw records privately while loading the valid records', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-27T12:00:00Z'))
    const rejectedHosts = [null, ...[{ id: '' }, { host: '' }, { port: '22' }, { port: 65536 }, { username: null }, { authType: 'invalid' }].map((patch) => ({ ...minimalHost, ...patch }))]
    const rejectedGroups = [null, { name: 'missing id' }, { id: 'g', name: 42 }]
    const raw = { version: 1, hosts: [minimalHost, ...rejectedHosts], groups: [{ id: 'g', name: 'valid' }, ...rejectedGroups] }
    writeJsonFile(filePath, raw)
    const log = vi.fn()
    const { data: loaded, hadRejectedRecords } = readStoreFile(filePath, log)
    expect(loaded.hosts).toHaveLength(1)
    expect(loaded.groups).toHaveLength(1)
    expect(log).toHaveBeenCalled()
    expect(hadRejectedRecords).toBe(true)
    const recovery = fs.readdirSync(directory).find((name) => name.includes('.rejected-'))!
    expect(recovery).toMatch(/^hopline-store\.rejected-\d{14}\.json$/)
    expect(fs.statSync(path.join(directory, recovery)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(path.join(directory, recovery), 'utf8'))).toEqual({ hosts: rejectedHosts, groups: rejectedGroups })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(raw)
    readStoreFile(filePath, log)
    expect(fs.readdirSync(directory).filter((name) => name.includes('.rejected-'))).toHaveLength(2)
    writeJsonFile(filePath, loaded)
    expect(JSON.parse(fs.readFileSync(path.join(directory, recovery), 'utf8')).hosts).toEqual(rejectedHosts)
  })

  it.each(['writeFileSync', 'fsyncSync'] as const)('stops loading on recovery %s failure and leaves the original intact', (operation) => {
    const raw = { version: 1, hosts: [minimalHost, null], groups: [] }
    writeJsonFile(filePath, raw)
    vi.spyOn(fs, operation).mockImplementation(() => { throw new Error('磁盘已满') })
    expect(() => readStoreFile(filePath, vi.fn())).toThrow('无法保留异常记录')
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(raw)
    expect(fs.readdirSync(directory)).toEqual(['hopline-store.json'])
  })

  it('syncs temporary contents before close and rename', () => {
    const sync = vi.spyOn(fs, 'fsyncSync')
    const close = vi.spyOn(fs, 'closeSync')
    const rename = vi.spyOn(fs, 'renameSync')
    writeJsonFile(filePath, emptyStore())
    expect(sync).toHaveBeenCalledTimes(1)
    const fd = sync.mock.calls[0]![0]
    expect(close).toHaveBeenCalledWith(fd)
    expect(sync.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!)
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]!)
  })

  it('does not replace the previous store when fsync fails', () => {
    writeJsonFile(filePath, emptyStore())
    const original = fs.readFileSync(filePath, 'utf8')
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('同步失败') })
    const rename = vi.spyOn(fs, 'renameSync')
    expect(() => writeJsonFile(filePath, { ...emptyStore(), hosts: [minimalHost] })).toThrow('同步失败')
    expect(rename).not.toHaveBeenCalled()
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
  })
})
