import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupService } from '../src/main/backup/service'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import * as format from '../src/core/backup-format'
import { writeJsonFile } from '../src/core/json-file'

vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('../src/main/secrets', () => ({ sealKey: (key: Uint8Array) => Buffer.from(key), openKey: (key: Buffer) => key }))
vi.mock('../src/core/backup-format', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/backup-format')>()
  return { ...actual, createKdfParams: () => actual.createKdfParams({ opslimit: 1, memlimit: 8192 }) }
})

const nativeFetch = globalThis.fetch
const password = 'master-password', name = '20261112000000000.hopline-backup'
const listing = `<response><href>/hopline/${name}</href></response>`
let directory: string, storeFile: string, vault: Vault, service: BackupService, file: Uint8Array, plaintext: Uint8Array
let save: ReturnType<typeof vi.fn<() => void>>

function gate<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-webdav-'))
  storeFile = path.join(directory, 'vault.json')
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  vault.saveHost({ name: '当前主机', host: 'current.test', username: 'u', port: 22, authType: 'password', password: 'keep', groupId: null })
  vault.updateSettings({ webdav: { url: 'https://dav.test', username: 'u', password: 'p', remoteDir: 'hopline' } })
  save = vi.fn(() => writeJsonFile(storeFile, vault.snapshot()))
  service = new BackupService(vault, path.join(directory, 'backups'), path.join(directory, 'key'), save)
  const verifier = await format.encryptVault(Buffer.from('hopline-vault-ok'), password, { opslimit: 1, memlimit: 8192 })
  vault.setBackupUnlock({ ...verifier.params, salt: Buffer.from(verifier.params.salt).toString('base64') }, Buffer.from(verifier.file).toString('base64'))
  await service.unlock(password, false)
  const source = new Vault(emptyStore(), new MemorySecretCodec())
  source.saveHost({ name: '恢复主机', host: 'restored.test', username: 'u', port: 22, authType: 'password', password: 'restored', groupId: null })
  plaintext = Buffer.from(JSON.stringify(source.exportPortable()))
  file = (await format.encryptVault(plaintext, password, { opslimit: 1, memlimit: 8192 })).file
  save(); save.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'PROPFIND'
    ? new Response(listing, { status: 207 }) : new Response(Buffer.from(file))))
})

afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  fs.rmSync(directory, { recursive: true, force: true })
})

function snapshot() { return { data: vault.snapshot(), disk: fs.readFileSync(storeFile) } }
function unchanged(before: ReturnType<typeof snapshot>) {
  expect(vault.snapshot()).toEqual(before.data); expect(fs.readFileSync(storeFile)).toEqual(before.disk)
  expect(save).not.toHaveBeenCalled()
}

describe('WebDAV operation ownership and commit boundary', () => {
  it('rejects concurrent operations and ignores cancellation from an older request', async () => {
    const firstEntered = gate(), secondEntered = gate(), download = gate<Response>()
    let requests = 0
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => {
      if (++requests === 1) {
        firstEntered.resolve()
        return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
      }
      if (init.method === 'PROPFIND') return Promise.resolve(new Response(listing, { status: 207 }))
      secondEntered.resolve(); return download.promise
    }))
    const first = service.webdav('pull', password, 'replace', 'first')
    const canceled = expect(first).rejects.toThrow('backup.webdavCanceled')
    await firstEntered.promise
    await expect(service.webdav('push', null, 'merge', 'concurrent')).rejects.toThrow('backup.webdavBusy')
    service.cancelWebdav('unrelated')
    expect(requests).toBe(1)
    service.cancelWebdav('first'); await canceled
    const next = service.webdav('pull', password, 'replace', 'second')
    await secondEntered.promise
    service.cancelWebdav('first')
    download.resolve(new Response(Buffer.from(file)))
    await next
    expect(vault.listHosts().map(host => host.host)).toEqual(['restored.test'])
    expect(save).toHaveBeenCalledTimes(1)
  })

  it.each(['cancel', 'timeout'] as const)('does not import when %s occurs during decryption', async kind => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const entered = gate(), finish = gate<Uint8Array>(), before = snapshot()
    vi.spyOn(format, 'decryptVault').mockImplementation(() => { entered.resolve(); return finish.promise })
    const task = service.webdav('pull', password, 'replace', 'decrypt')
    const rejected = expect(task).rejects.toThrow(kind === 'cancel' ? 'backup.webdavCanceled' : 'backup.webdavTimeout')
    await entered.promise
    if (kind === 'cancel') service.cancelWebdav('decrypt')
    else now = 120_001 // The event loop did not run the timeout callback.
    finish.resolve(plaintext); await rejected
    unchanged(before)
  })

  it.each(['cancel', 'timeout'] as const)('does not upload or create the implicit first master password after %s during encryption', async kind => {
    const fresh = new Vault(emptyStore(), new MemorySecretCodec())
    fresh.updateSettings({ webdav: { url: 'https://dav.test', username: 'u', password: 'p', remoteDir: 'hopline' } })
    service = new BackupService(fresh, path.join(directory, 'backups'), path.join(directory, 'key'), save)
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const entered = gate(), finish = gate<Uint8Array>()
    vi.spyOn(format, 'encryptWithKey').mockImplementation(() => { entered.resolve(); return finish.promise })
    const task = service.webdav('push', password, 'merge', 'encrypt')
    const rejected = expect(task).rejects.toThrow(kind === 'cancel' ? 'backup.webdavCanceled' : 'backup.webdavTimeout')
    await entered.promise
    if (kind === 'cancel') service.cancelWebdav('encrypt')
    else now = 120_001
    finish.resolve(file); await rejected
    expect(fresh.kdf()).toBeNull(); expect(service.status().unlocked).toBe(false)
    expect(save).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'timeout'] as const)('reports a synchronously committed restore as success even if %s is observed inside the save', async kind => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    save.mockImplementation(() => {
      writeJsonFile(storeFile, vault.snapshot())
      if (kind === 'cancel') service.cancelWebdav('commit')
      else now = 120_001
    })
    await expect(service.webdav('pull', password, 'replace', 'commit')).resolves.toBeUndefined()
    expect(vault.listHosts().map(host => host.host)).toEqual(['restored.test'])
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf8'))).toEqual(vault.snapshot())
    expect(save).toHaveBeenCalledTimes(1)
  })

  it.each(['cancel', 'timeout'] as const)('reports an acknowledged remote upload as success when %s races with its successful status', async kind => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (kind === 'cancel') service.cancelWebdav('upload')
      else now = 120_001
      return new Response(new ReadableStream({ cancel }), { status: 201 })
    }))
    await expect(service.webdav('push', null, 'merge', 'upload')).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })

  it('uses one monotonic deadline for listing and download rather than resetting it per request', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const before = snapshot(), cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      if (init.method === 'PROPFIND') { now = 80_000; return new Response(listing, { status: 207 }) }
      now = 120_001; return new Response(new ReadableStream({ cancel }))
    }))
    await expect(service.webdav('pull', password, 'replace', 'deadline')).rejects.toThrow('backup.webdavTimeout')
    expect(fetch).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(1)
    unchanged(before)
  })

  it('keeps MKCOL directory creation within the original upload deadline', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const methods: string[] = [], before = snapshot(), cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      methods.push(init.method!)
      if (init.method === 'PUT') { now = 80_000; return new Response(null, { status: 409 }) }
      now = 120_001; return new Response(new ReadableStream({ cancel }), { status: 201 })
    }))
    await expect(service.webdav('push', null, 'merge', 'mkdir')).rejects.toThrow('backup.webdavTimeout')
    expect(methods).toEqual(['PUT', 'MKCOL']); expect(cancel).toHaveBeenCalledTimes(1)
    unchanged(before)
  })

  it.each([['headers', 'timeout'], ['body', 'timeout'], ['headers', 'cancel'], ['body', 'cancel']] as const)('aborts a real HTTP peer stalled at %s after %s', async (stage, kind) => {
    vi.stubGlobal('fetch', nativeFetch)
    const entered = gate(), closed = gate()
    const server = http.createServer((request, response) => {
      if (stage === 'body' && request.method === 'PROPFIND') { response.writeHead(207); response.end(listing); return }
      if (stage === 'body') { response.writeHead(200); response.write(Buffer.from(file).subarray(0, 10)) }
      response.on('close', () => closed.resolve()); entered.resolve()
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      vault.updateSettings({ webdav: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, username: 'u', password: 'p', remoteDir: 'hopline' } })
      save(); save.mockClear()
      const before = snapshot()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const task = service.webdav('pull', password, 'replace', 'stalled')
      const rejected = expect(task).rejects.toThrow(kind === 'timeout' ? 'backup.webdavTimeout' : 'backup.webdavCanceled')
      await entered.promise
      if (kind === 'timeout') await vi.advanceTimersByTimeAsync(120_000)
      else service.cancelWebdav('stalled')
      await rejected; await closed.promise
      unchanged(before)
    } finally { vi.useRealTimers(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
