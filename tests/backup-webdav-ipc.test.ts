import { beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import type { IpcDeps } from '../src/main/ipc'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke }, webUtils: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi
beforeEach(() => vi.clearAllMocks())

function setup() {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const host = vault.saveHost({ name: '原主机', host: 'original.test', port: 22, username: 'u', authType: 'agent', groupId: null })
  const pool = new ConnectionPool(vault, { verifyHost: async () => false, onKeyboard: async () => null })
  const invalidateAll = vi.spyOn(pool, 'invalidateAll'), invalidate = vi.spyOn(pool, 'invalidate')
  const effects = { collect: vi.fn(), forwards: vi.fn(), runbook: vi.fn(), security: vi.fn(), language: vi.fn(), send: vi.fn(), invalidateAll }
  const collectInvalidated = vi.fn(), save = vi.fn()
  const backup = { importFrom: vi.fn(async () => {}), webdav: vi.fn(async () => {}), cancelWebdav: vi.fn(), scheduleAuto: vi.fn() }
  const win = { isDestroyed: () => false, webContents: { send: effects.send } }
  registerIpc({ vault, save, sessions: { pool }, backup, getWindow: () => win,
    collect: { prune: effects.collect, invalidate: collectInvalidated }, forwards: { reconcile: effects.forwards },
    runbook: { prune: effects.runbook }, security: { prune: effects.security }, onLanguage: effects.language } as unknown as IpcDeps)
  const event = { sender: win.webContents }
  const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  return { vault, host, pool, invalidate, collectInvalidated, effects, save, backup, event, handler }
}

it('bridges WebDAV request identity and cancellation and guards both channels', async () => {
  await bridge.backup.webdav('pull', null, 'replace', 'request')
  await bridge.backup.cancelWebdav('request')
  expect(mocks.invoke.mock.calls).toEqual([['backup:webdav', 'pull', null, 'replace', 'request'], ['backup:webdavCancel', 'request']])
  const { handler, backup, event } = setup()
  await expect(handler('backup:webdav')({ sender: {} }, 'pull', null, 'replace', 'request')).rejects.toThrow('拒绝')
  expect(() => handler('backup:webdavCancel')({ sender: {} }, 'request')).toThrow('拒绝')
  await expect(handler('backup:webdav')(event, 'pull', null, 'replace', undefined)).rejects.toThrow('参数不完整')
  expect(() => handler('backup:webdavCancel')(event, '')).toThrow('参数不完整')
  expect(backup.webdav).not.toHaveBeenCalled(); expect(backup.cancelWebdav).not.toHaveBeenCalled()
  await handler('backup:webdav')(event, 'push', null, 'merge', 'request')
  handler('backup:webdavCancel')(event, 'request')
  expect(backup.webdav).toHaveBeenCalledExactlyOnceWith('push', null, 'merge', 'request')
  expect(backup.cancelWebdav).toHaveBeenCalledExactlyOnceWith('request')
})

for (const channel of ['backup:import', 'backup:webdav']) {
  it.each(['collect', 'forwards', 'runbook', 'security', 'invalidateAll', 'language', 'send'] as const)(`${channel} keeps a committed restore successful when %s fails and still attempts later effects`, async failing => {
    const { handler, event, effects, save, backup } = setup()
    if (failing === 'forwards') effects[failing].mockRejectedValue(new Error('async reconciliation failed'))
    else effects[failing].mockImplementation(() => { throw new Error('post-commit failed') })
    await expect(handler(channel)(event, channel === 'backup:import' ? '/tmp/backup' : 'pull', null, 'replace', 'restore')).resolves.toBeUndefined()
    expect(channel === 'backup:import' ? backup.importFrom : backup.webdav).toHaveBeenCalledTimes(1)
    for (const effect of Object.values(effects)) expect(effect).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })

  it(`${channel} leaves all follow-up effects untouched when restore fails before commit`, async () => {
    const { handler, event, effects, backup, collectInvalidated } = setup()
    const restore = channel === 'backup:import' ? backup.importFrom : backup.webdav
    restore.mockRejectedValueOnce(new Error('disk write failed'))
    await expect(handler(channel)(event, channel === 'backup:import' ? '/tmp/backup' : 'pull', null, 'replace', 'restore')).rejects.toThrow('disk write failed')
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled()
    expect(collectInvalidated).not.toHaveBeenCalled()
  })

  it.each([true, false])(`${channel} invalidates restored observations even when the original connection target appears unchanged (%s)`, async changed => {
    const { handler, event, backup, vault, host, collectInvalidated } = setup()
    const restore = channel === 'backup:import' ? backup.importFrom : backup.webdav
    restore.mockImplementation(async () => { vault.saveHost({ ...host, host: changed ? 'restored.test' : host.host, name: '备份名称' }) })
    await handler(channel)(event, channel === 'backup:import' ? '/tmp/backup' : 'pull', null, 'merge', 'restore')
    expect(collectInvalidated).toHaveBeenCalledExactlyOnceWith(host.id)
  })

  it(`${channel} discards observations collected from an intermediate target while waiting for restore`, async () => {
    const { handler, event, backup, vault, host, collectInvalidated } = setup()
    let finish!: () => void
    const waiting = new Promise<void>(resolve => { finish = resolve })
    const restore = channel === 'backup:import' ? backup.importFrom : backup.webdav
    restore.mockImplementation(async () => { await waiting; vault.saveHost(host) })
    const pending = handler(channel)(event, channel === 'backup:import' ? '/tmp/backup' : 'pull', null, 'merge', 'restore')
    handler('hosts:save')(event, { ...host, host: 'intermediate.test' })
    // A new sample from the intermediate target may now exist.
    collectInvalidated.mockClear()
    finish(); await pending
    expect(vault.getHost(host.id)?.host).toBe(host.host)
    expect(collectInvalidated).toHaveBeenCalledExactlyOnceWith(host.id)
  })
}

it('invalidates a saved host observation after endpoint edits but keeps it after a name edit', () => {
  const { handler, event, host, collectInvalidated, invalidate } = setup()
  handler('hosts:save')(event, { ...host, name: '新名称' })
  expect(collectInvalidated).not.toHaveBeenCalled()
  handler('hosts:save')(event, { ...host, host: 'new.test' })
  expect(collectInvalidated).toHaveBeenCalledExactlyOnceWith(host.id)
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(host.id)
})
