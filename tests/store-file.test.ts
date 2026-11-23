import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyStore } from '../src/core/vault'
import { readStoreFile } from '../src/core/store-file'
import { openVault } from '../src/main/persist'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { logError } from '../src/main/logger'
import { emptyHostMeta } from '../src/core/host-meta'
import { NewerVersionError } from '../src/core/vault-migrate'
import { TOMBSTONE_RETENTION_MS } from '../src/core/vault-tombstones'
import legacy from './fixtures/vault-v1.json'

const state = vi.hoisted(() => ({ directory: '' }))
let temporaryRoot: string
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }))
vi.mock('../src/main/secrets', () => ({ createSafeCodec: () => ({ encrypt: (s: string) => s, decrypt: (s: string) => s }) }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn() }))

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-store-'))
  state.directory = temporaryRoot
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

describe('versioned disk migration', () => {
  const time = Date.UTC(2026, 9, 27)
  const storePath = () => path.join(state.directory, 'hopline-store.json')
  const fixturePath = path.join(import.meta.dirname, 'fixtures', 'vault-v1.json')

  it('loads the v1 fixture as v8 and backs up its exact bytes before the first save', () => {
    vi.useFakeTimers().setSystemTime(time)
    const original = fs.readFileSync(fixturePath)
    fs.writeFileSync(storePath(), original)
    expect(readStoreFile(storePath()).migratedFrom).toBe(1)
    const opened = openVault()
    const data = opened.vault.snapshot()
    expect(data.version).toBe(9)
    const { jump, ...legacyHost } = legacy.hosts[0]!
    expect(data.hosts[0]).toMatchObject({ ...legacyHost, jumps: jump ? [jump] : [], meta: emptyHostMeta(), deletedAt: null })
    expect(data.groups[0]).toEqual({ ...legacy.groups[0], updatedAt: time, deletedAt: null })
    expect(data.settings.theme).toBe('dark')
    expect(fs.readFileSync(`${storePath()}.v1.bak`)).toEqual(original)
    expect(fs.readFileSync(storePath())).toEqual(original)
    opened.save()
    expect(JSON.parse(fs.readFileSync(storePath(), 'utf8'))).toEqual(data)
    expect(readStoreFile(storePath()).migratedFrom).toBeNull()
    expect(fs.readFileSync(`${storePath()}.v1.bak`)).toEqual(original)
  })

  it('backs up the exact v2 bytes before saving v8 with agent:null and jumps added', () => {
    const opened = openVault()
    opened.vault.saveHost({ name: 'v2', host: 'old.test', port: 22, username: 'u', authType: 'password', groupId: null, password: 'secret' })
    const expected = opened.vault.snapshot()
    const v2 = { ...expected, version: 2, hosts: expected.hosts.map(({ agent: _agent, jumps, ...host }) => ({ ...host, jump: jumps[0] ?? null })) }
    const bytes = JSON.stringify(v2, null, 4) + '\n'
    fs.writeFileSync(storePath(), bytes)
    const migrated = openVault()
    expect(migrated.vault.snapshot()).toEqual(expected)
    expect(fs.readFileSync(`${storePath()}.v2.bak`, 'utf8')).toBe(bytes)
    expect(fs.readFileSync(storePath(), 'utf8')).toBe(bytes)
    migrated.save()
    expect(JSON.parse(fs.readFileSync(storePath(), 'utf8'))).toEqual(expected)
    expect(readStoreFile(storePath()).migratedFrom).toBeNull()
  })

  it('never overwrites an existing migration backup', () => {
    fs.writeFileSync(storePath(), JSON.stringify(legacy))
    fs.writeFileSync(`${storePath()}.v1.bak`, '先前的备份')
    openVault().save()
    expect(fs.readFileSync(`${storePath()}.v1.bak`, 'utf8')).toBe('先前的备份')
    expect(JSON.parse(fs.readFileSync(storePath(), 'utf8')).version).toBe(9)
  })

  it('backs up the exact v7 bytes and saves v8 defaults without changing timestamps or secrets', () => {
    vi.useFakeTimers().setSystemTime(time)
    const original = openVault()
    original.vault.saveHost({ name: 'v7', host: 'legacy.test', port: 22, username: 'u', authType: 'password', groupId: null, password: 'temporary-secret' })
    const expected = original.vault.snapshot()
    const v7 = { ...expected, version: 7, hosts: expected.hosts.map(({ connectionTimeoutSec: _timeout, keepaliveIntervalSec: _keepalive, ...host }) => host) }
    const bytes = JSON.stringify(v7, null, 4) + '\n'
    fs.writeFileSync(storePath(), bytes)
    vi.setSystemTime(time + 1000)
    const migrated = openVault()
    expect(migrated.vault.snapshot()).toEqual(expected)
    expect(fs.readFileSync(`${storePath()}.v7.bak`, 'utf8')).toBe(bytes)
    expect(fs.readFileSync(storePath(), 'utf8')).toBe(bytes)
    migrated.save()
    expect(JSON.parse(fs.readFileSync(storePath(), 'utf8'))).toEqual(expected)
    expect(readStoreFile(storePath())).toMatchObject({ data: expected, migratedFrom: null, hadRejectedRecords: false })
    expect(fs.readFileSync(`${storePath()}.v7.bak`, 'utf8')).toBe(bytes)
  })

  it('backs up v1 bytes before immediate rejected-record cleanup saves', () => {
    const raw = JSON.stringify({ ...legacy, hosts: [...legacy.hosts, { id: 'broken' }] }, null, 4) + '\n'
    fs.writeFileSync(storePath(), raw)
    const copy = vi.spyOn(fs, 'copyFileSync')
    const rename = vi.spyOn(fs, 'renameSync')
    const opened = openVault()
    expect(copy).toHaveBeenCalledWith(storePath(), `${storePath()}.v1.bak`, fs.constants.COPYFILE_EXCL)
    expect(copy.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]!)
    expect(fs.readFileSync(`${storePath()}.v1.bak`, 'utf8')).toBe(raw)
    expect(JSON.parse(fs.readFileSync(storePath(), 'utf8'))).toEqual(opened.vault.snapshot())
    const rejected = fs.readdirSync(state.directory).find((name) => name.includes('.rejected-'))!
    expect(JSON.parse(fs.readFileSync(path.join(state.directory, rejected), 'utf8'))).toEqual({ hosts: [{ id: 'broken' }], groups: [] })
  })

  it.each([false, true])('stops all saves when migration backup fails (rejected records: %s)', (withRejected) => {
    const raw = JSON.stringify({ ...legacy, hosts: [...legacy.hosts, ...(withRejected ? [null] : [])] })
    fs.writeFileSync(storePath(), raw)
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('磁盘已满') })
    const rename = vi.spyOn(fs, 'renameSync')
    expect(() => openVault()).toThrow('无法备份迁移前的数据文件')
    expect(rename).not.toHaveBeenCalled()
    expect(fs.readFileSync(storePath(), 'utf8')).toBe(raw)
    expect(fs.existsSync(`${storePath()}.tmp`)).toBe(false)
  })

  it('leaves a version 99 file, its path, inode and mtime unchanged without quarantine or empty saves', () => {
    const raw = JSON.stringify({ version: 99, hosts: [{ future: true }], groups: [] }, null, 2)
    fs.writeFileSync(storePath(), raw)
    fs.utimesSync(storePath(), 123456, 123456)
    const before = fs.statSync(storePath())
    expect(() => readStoreFile(storePath())).toThrow(NewerVersionError)
    expect(() => readStoreFile(path.relative(process.cwd(), storePath())))
      .toThrow(expect.objectContaining({ filePath: storePath() }))
    expect(() => openVault()).toThrow('数据文件来自更新版本的 Hopline')
    expect(fs.readFileSync(storePath(), 'utf8')).toBe(raw)
    const after = fs.statSync(storePath())
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
    expect(fs.existsSync(`${storePath()}.v1.bak`)).toBe(false)
    expect(fs.existsSync(`${storePath()}.tmp`)).toBe(false)
    expect(fs.readdirSync(state.directory)).toEqual(['hopline-store.json'])
    expect(logError).not.toHaveBeenCalled()
  })

  it.each([null, 'bad', { currency: 'eur' }, { price: -1 }, { tags: ['x'.repeat(25)] }])('defaults bad v2 metadata and deletion fields without rejecting hosts: %j', (meta) => {
    vi.useFakeTimers().setSystemTime(time)
    const raw = { ...legacy, version: 2,
      hosts: [{ ...legacy.hosts[0], meta, deletedAt: 'bad' }],
      groups: [{ ...legacy.groups[0], updatedAt: 'bad', deletedAt: -1, createdAt: 123 }, { id: 'no-time', name: '分组', sortOrder: 1, updatedAt: null }]
    }
    fs.writeFileSync(storePath(), JSON.stringify(raw))
    const { data, hadRejectedRecords, migratedFrom } = readStoreFile(storePath())
    expect(data.hosts[0]).toMatchObject({ id: 'host-v1', meta: emptyHostMeta(), deletedAt: null })
    expect(data.groups[0]).toMatchObject({ updatedAt: 123, deletedAt: null })
    expect(data.groups[1]).toMatchObject({ updatedAt: time, deletedAt: null })
    expect(hadRejectedRecords).toBe(false)
    expect(migratedFrom).toBe(2)
    expect(fs.readdirSync(state.directory)).toEqual(['hopline-store.json'])
  })

  it('prunes expired disk tombstones, keeps the 90-day boundary, and repairs dangling group links', () => {
    vi.useFakeTimers().setSystemTime(time)
    const boundary = time - TOMBSTONE_RETENTION_MS
    const data = { ...legacy, version: 2,
      groups: [{ id: 'expired', updatedAt: boundary - 1, deletedAt: boundary - 1 }, { id: 'boundary', updatedAt: boundary, deletedAt: boundary }],
      hosts: [
        { ...legacy.hosts[0], id: 'active', groupId: 'expired', deletedAt: null },
        { id: 'expired', updatedAt: boundary - 1, deletedAt: boundary - 1 },
        { ...legacy.hosts[0], id: 'boundary', updatedAt: boundary, deletedAt: boundary }
      ]
    }
    fs.writeFileSync(storePath(), JSON.stringify(data))
    const loaded = readStoreFile(storePath())
    expect(loaded.hadRejectedRecords).toBe(false)
    expect(loaded.data.hosts.map((host) => host.id)).toEqual(['active', 'boundary'])
    expect(loaded.data.hosts[0]?.groupId).toBeNull()
    expect(loaded.data.hosts[1]?.passwordEnc).toBeNull()
    expect(loaded.data.groups.map((group) => group.id)).toEqual(['boundary'])
    expect(fs.readdirSync(state.directory)).toEqual(['hopline-store.json'])
  })
})

describe('corrupt local data recovery', () => {
  it('persists the cleaned store after recovery so reopening creates only one rejected file', () => {
    const opened = openVault()
    opened.vault.saveHost({ name: 'valid', host: 'valid.test', port: 22, username: 'u', authType: 'password', groupId: null })
    const clean = opened.vault.snapshot()
    const rejected = { id: 'invalid', host: 'invalid.test' }
    fs.writeFileSync(opened.filePath, JSON.stringify({ ...clean, hosts: [...clean.hosts, rejected] }))
    const first = openVault()
    expect(first.vault.snapshot()).toEqual(clean)
    expect(JSON.parse(fs.readFileSync(opened.filePath, 'utf8'))).toEqual(clean)
    const second = openVault()
    expect(second.vault.snapshot()).toEqual(clean)
    const files = fs.readdirSync(state.directory).filter((name) => name.includes('.rejected-'))
    expect(files).toHaveLength(1)
    const recovery = path.join(state.directory, files[0]!)
    expect(JSON.parse(fs.readFileSync(recovery, 'utf8'))).toEqual({ hosts: [rejected], groups: [] })
    expect(fs.statSync(recovery).mode & 0o777).toBe(0o600)
  })

  it('does not clean the store if preserving rejected records fails', () => {
    const filePath = path.join(state.directory, 'hopline-store.json')
    const raw = JSON.stringify({ ...emptyStore(), hosts: [null] })
    fs.writeFileSync(filePath, raw)
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('同步失败') })
    expect(() => openVault()).toThrow('无法保留异常记录')
    expect(fs.readFileSync(filePath, 'utf8')).toBe(raw)
    expect(fs.readdirSync(state.directory)).toEqual(['hopline-store.json'])
  })

  it('preserves the rejected records before attempting to save the cleaned store', () => {
    const filePath = path.join(state.directory, 'hopline-store.json')
    const raw = JSON.stringify({ ...emptyStore(), hosts: [null] })
    fs.writeFileSync(filePath, raw)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const preserved = fs.readdirSync(state.directory).find((name) => name.includes('.rejected-'))!
      expect(JSON.parse(fs.readFileSync(path.join(state.directory, preserved), 'utf8'))).toEqual({ hosts: [null], groups: [] })
      throw new Error('保存失败')
    })
    expect(() => openVault()).toThrow('保存失败')
    expect(fs.readFileSync(filePath, 'utf8')).toBe(raw)
  })

  it('reads a missing store without Electron or creating any files', () => {
    expect(readStoreFile(path.join(state.directory, 'missing.json'))).toEqual({ data: emptyStore(), hadRejectedRecords: false, migratedFrom: null })
    expect(fs.readdirSync(state.directory)).toEqual([])
  })

  it('stops opening the vault if the damaged file cannot be preserved', () => {
    const filePath = path.join(state.directory, 'hopline-store.json')
    fs.writeFileSync(filePath, '{broken')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('无法重命名') })
    expect(() => openVault()).toThrow('无法保留损坏的数据文件')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{broken')
    expect(fs.readdirSync(state.directory)).toEqual(['hopline-store.json'])
    expect(logError).toHaveBeenCalled()
  })

  it('tightens permissions on leftover temporary files before saving', () => {
    const opened = openVault()
    const tmp = `${opened.filePath}.tmp`
    fs.writeFileSync(tmp, 'leftover', { mode: 0o644 })
    opened.save()
    expect(fs.statSync(opened.filePath).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(tmp)).toBe(false)
  })

  it.each(['{broken', 'null', '{}', '{"version":0,"hosts":[],"groups":[]}', '{"version":1,"hosts":{},"groups":[]}'])('preserves invalid host store: %s', (raw) => {
    const filePath = path.join(state.directory, 'hopline-store.json')
    fs.writeFileSync(filePath, raw)
    const opened = openVault()
    expect(opened.vault.snapshot()).toEqual(emptyStore())
    expect(fs.existsSync(filePath)).toBe(false)
    const preserved = fs.readdirSync(state.directory)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).toMatch(/^hopline-store\.corrupt-\d{14}\.json$/)
    expect(logError).toHaveBeenCalled()
    opened.save()
    expect(fs.readFileSync(path.join(state.directory, preserved[0]!), 'utf8')).toBe(raw)
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it.each(['{broken', 'null', '{}', '{"entries":[null]}', '{"entries":[{"host":"x","port":"22"}]}'])('preserves invalid known hosts: %s', (raw) => {
    const filePath = path.join(state.directory, 'known_hosts.json')
    fs.writeFileSync(filePath, raw)
    const known = new KnownHostFile(filePath)
    known.load()
    expect(known.entries).toEqual([])
    expect(fs.existsSync(filePath)).toBe(false)
    const preserved = fs.readdirSync(state.directory)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).toMatch(/^known_hosts\.corrupt-\d{14}\.json$/)
    expect(logError).toHaveBeenCalled()
    known.remember('example.test', 22, 'SHA256:test')
    expect(fs.readFileSync(path.join(state.directory, preserved[0]!), 'utf8')).toBe(raw)
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    const reloaded = new KnownHostFile(filePath)
    reloaded.load()
    expect(reloaded.judge('example.test', 22, 'SHA256:test')).toBe('trusted')
  })

  it('does not overwrite earlier quarantines within the same second', () => {
    vi.useFakeTimers().setSystemTime(new Date(2026, 9, 27, 12))
    const filePath = path.join(state.directory, 'hopline-store.json')
    fs.writeFileSync(filePath, 'first')
    openVault()
    fs.writeFileSync(filePath, 'second')
    openVault()
    expect(fs.readdirSync(state.directory).map((name) => fs.readFileSync(path.join(state.directory, name), 'utf8')).sort())
      .toEqual(['first', 'second'])
  })

  it('creates private data directories and stores', () => {
    state.directory = path.join(state.directory, 'data')
    const opened = openVault()
    opened.save()
    expect(fs.statSync(state.directory).mode & 0o777).toBe(0o700)
    expect(fs.statSync(opened.filePath).mode & 0o777).toBe(0o600)
    const known = new KnownHostFile(path.join(state.directory, 'ssh', 'known_hosts.json'))
    known.remember('x', 22, 'SHA256:test')
    expect(fs.statSync(path.join(state.directory, 'ssh')).mode & 0o777).toBe(0o700)
  })

  it('preserves valid hosts and fills missing settings with defaults', () => {
    const opened = openVault()
    opened.vault.saveHost({ name: 'edge', host: 'example.test', port: 22, username: 'u', authType: 'password', groupId: null })
    opened.save()
    expect(openVault().vault.snapshot()).toEqual(opened.vault.snapshot())
    fs.writeFileSync(opened.filePath, JSON.stringify({ version: 1, hosts: [], groups: [], settings: { theme: 'dark', backup: { rememberUnlock: false } } }))
    expect(openVault().vault.snapshot().settings).toEqual({ ...emptyStore().settings, theme: 'dark', backup: { ...emptyStore().settings.backup, rememberUnlock: false } })
  })

  it('does not treat filesystem read failures as an empty store', () => {
    fs.mkdirSync(path.join(state.directory, 'hopline-store.json'))
    expect(() => openVault()).toThrow()
    expect(fs.existsSync(path.join(state.directory, 'hopline-store.json'))).toBe(true)
  })
})
