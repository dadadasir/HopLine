import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { SessionHub } from '../src/main/sessions'
import * as sftpOps from '../src/main/sftp/ops'
import { startMiniSshd } from './support/mini-sshd.mjs'

vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

describe('host-owned files', () => {
  let workspace: string
  let server: Awaited<ReturnType<typeof startMiniSshd>>
  let vault: Vault
  let hostId: string
  let hub: SessionHub
  const emit = vi.fn()

  beforeEach(async () => {
    emit.mockClear()
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-host-files-'))
    server = await startMiniSshd({ password: 'test', root: path.join(workspace, 'server') })
    vault = new Vault(emptyStore(), new MemorySecretCodec())
    hostId = vault.saveHost({ groupId: null, name: 'files', host: '127.0.0.1', port: server.port,
      username: 'hop', authType: 'password', password: 'test' }).id
    const known = new KnownHostFile(path.join(workspace, 'known.json'))
    vi.spyOn(known, 'judge').mockReturnValue('trusted')
    hub = new SessionHub(vault, known, emit, workspace)
  })

  afterEach(async () => {
    await hub?.closeAll()
    await hub?.pool.closeAll()
    await server?.close()
    vi.restoreAllMocks()
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('shares file access without opening a shell and supports real directory operations', async () => {
    const [id, again] = await Promise.all([hub.openHostFiles(hostId), hub.openHostFiles(hostId)])
    expect(id).toBe(again)
    expect(hub.list()).toEqual([])
    expect(server.shellSizes).toEqual([])
    expect(emit.mock.calls.filter(([event]) => event === 'ssh:status')).toEqual([])
    expect((await hub.sftpList(id, '/')).entries.map((entry) => entry.name)).toContain('readme.txt')
    await hub.sftpMkdir(id, '/new-folder')
    await hub.sftpRename(id, '/new-folder', '/renamed-folder')
    expect(fs.statSync(path.join(server.root, 'renamed-folder')).isDirectory()).toBe(true)
    await hub.sftpRemove(id, '/renamed-folder')
    expect(fs.existsSync(path.join(server.root, 'renamed-folder'))).toBe(false)
    expect(server.acceptedConnections).toBe(1)
  })

  it('keeps an in-flight upload alive after closing a terminal of the same host', async () => {
    const terminal = await hub.connect(hostId, 80, 24)
    const id = await hub.openHostFiles(hostId)
    const local = path.join(workspace, 'upload.txt')
    fs.writeFileSync(local, 'transfer survives closing the terminal')
    const original = sftpOps.uploadFile
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const upload = vi.spyOn(sftpOps, 'uploadFile').mockImplementationOnce(async (...args) => {
      await gate
      return original(...args)
    })
    try {
      await hub.upload(id, [local], '/')
      await vi.waitFor(() => expect(upload).toHaveBeenCalled())
      await hub.close(terminal.id)
      expect(hub.jobsFor(id)[0]).toMatchObject({ status: 'running', hostId, sessionId: id })
      expect(hub.list()).toEqual([])
      release()
      await vi.waitFor(() => expect(hub.jobsFor(id)[0]?.status).toBe('done'))
      expect(fs.readFileSync(path.join(server.root, 'upload.txt'), 'utf8')).toBe(fs.readFileSync(local, 'utf8'))
      expect(hub.jobsFor()).toEqual(hub.jobsFor(id))
      expect((await hub.sftpList(id, '/')).entries.map((entry) => entry.name)).toContain('upload.txt')
    } finally { release() }
  })

  it('reopens files after connection loss without creating a terminal', async () => {
    const id = await hub.openHostFiles(hostId)
    server.disconnectAll()
    await vi.waitFor(() => expect(hub.pool.isOpen(hostId)).toBe(false))
    expect((await hub.sftpList(id, '/')).entries.length).toBeGreaterThan(0)
    expect(await hub.openHostFiles(hostId)).toBe(id)
    expect(server.acceptedConnections).toBe(2)
    expect(server.shellSizes).toEqual([])
  })

  it('uses an edited endpoint on the next file visit while retaining access after a rename', async () => {
    const id = await hub.openHostFiles(hostId)
    vault.saveHost({ ...vault.getHost(hostId)!, name: 'renamed' })
    expect(await hub.openHostFiles(hostId)).toBe(id)
    const other = await startMiniSshd({ password: 'test', root: path.join(workspace, 'other') })
    try {
      fs.writeFileSync(path.join(other.root, 'other-server.txt'), 'new endpoint')
      vault.saveHost({ ...vault.getHost(hostId)!, port: other.port })
      hub.pool.invalidate(hostId)
      const next = await hub.openHostFiles(hostId)
      expect(next).not.toBe(id)
      expect((await hub.sftpList(next, '/')).entries.map((entry) => entry.name)).toContain('other-server.txt')
      expect(hub['sessions'].has(id)).toBe(false)
      expect(other.shellSizes).toEqual([])
    } finally { await other.close() }
  })

  it('closes file contexts on host deletion and cancels their transfer jobs', async () => {
    const id = await hub.openHostFiles(hostId)
    const session = hub['sessions'].get(id)!
    hub['enqueue'](session, { direction: 'download', name: 'pending', localPath: workspace,
      remotePath: '/readme.txt', total: 8, run: ({ signal }) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }) })
    expect(hub.jobsFor(id)[0]?.status).toBe('running')
    vault.deleteHost(hostId)
    hub.pool.invalidate(hostId)
    await hub.closeHost(hostId)
    expect(session.queue.list()[0]?.status).toBe('cancelled')
    expect(emit.mock.calls.some(([event, job]) => event === 'transfer:event' &&
      job.sessionId === id && job.status === 'cancelled')).toBe(true)
    expect(hub.jobsFor()).toEqual([])
    await expect(hub.sftpList(id, '/')).rejects.toThrow('会话不存在')
    await expect(hub.openHostFiles(hostId)).rejects.toThrow('主机不存在')
    await vi.waitFor(() => expect(server.activeConnections).toBe(0))
  })

  it('lets a transfer finish on the previous endpoint after editing host connection settings', async () => {
    const id = await hub.openHostFiles(hostId)
    const local = path.join(workspace, 'previous-endpoint.txt')
    fs.writeFileSync(local, 'keep the transfer on its original server')
    const original = sftpOps.uploadFile
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const upload = vi.spyOn(sftpOps, 'uploadFile').mockImplementationOnce(async (...args) => {
      await gate
      return original(...args)
    })
    const other = await startMiniSshd({ password: 'test', root: path.join(workspace, 'other') })
    try {
      await hub.upload(id, [local], '/')
      await vi.waitFor(() => expect(upload).toHaveBeenCalled())
      vault.saveHost({ ...vault.getHost(hostId)!, port: other.port })
      hub.pool.invalidate(hostId)
      expect(await hub.openHostFiles(hostId)).not.toBe(id)
      expect(hub.jobsFor(id)[0]?.status).toBe('running')
      release()
      await vi.waitFor(() => expect(emit.mock.calls.some(([event, job]) =>
        event === 'transfer:event' && job.sessionId === id && job.status === 'done')).toBe(true))
      expect(fs.readFileSync(path.join(server.root, 'previous-endpoint.txt'), 'utf8')).toBe(fs.readFileSync(local, 'utf8'))
      expect(fs.existsSync(path.join(other.root, 'previous-endpoint.txt'))).toBe(false)
      await vi.waitFor(() => expect(hub['sessions'].has(id)).toBe(false))
    } finally { release(); await other.close() }
  })

  it('uses the normal host-key trust prompt and can retry after rejection', async () => {
    vi.mocked(hub['known'].judge).mockReturnValue('unknown')
    const opening = hub.openHostFiles(hostId)
    const rejected = expect(opening).rejects.toThrow()
    await vi.waitFor(() => expect(emit.mock.calls.some(([event]) => event === 'hostkey:prompt')).toBe(true))
    const prompt = emit.mock.calls.find(([event]) => event === 'hostkey:prompt')![1]
    hub.respondHostKey(prompt.requestId, 'reject')
    await rejected
    vi.mocked(hub['known'].judge).mockReturnValue('trusted')
    const id = await hub.openHostFiles(hostId)
    expect((await hub.sftpList(id, '/')).entries.length).toBeGreaterThan(0)
    expect(hub.list()).toEqual([])
  })

  it('does not reconnect an old file context to edited connection settings', async () => {
    const id = await hub.openHostFiles(hostId)
    const other = await startMiniSshd({ password: 'test', root: path.join(workspace, 'other') })
    try {
      vault.saveHost({ ...vault.getHost(hostId)!, port: other.port })
      hub.pool.invalidate(hostId)
      server.disconnectAll()
      await vi.waitFor(() => expect(hub['sessions'].get(id)?.lease).toBeUndefined())
      await expect(hub.sftpList(id, '/')).rejects.toThrow('主机连接配置已更改')
      expect(other.acceptedConnections).toBe(0)
      const fresh = await hub.openHostFiles(hostId)
      expect(fresh).not.toBe(id)
      expect((await hub.sftpList(fresh, '/')).entries.length).toBeGreaterThan(0)
      expect(other.acceptedConnections).toBe(1)
    } finally { await other.close() }
  })

  it('cancels pending file authentication when the host is deleted', async () => {
    vi.mocked(hub['known'].judge).mockReturnValue('unknown')
    const opening = hub.openHostFiles(hostId)
    const rejected = expect(opening).rejects.toThrow()
    await vi.waitFor(() => expect(emit.mock.calls.some(([event]) => event === 'hostkey:prompt')).toBe(true))
    vault.deleteHost(hostId)
    await hub.closeHost(hostId)
    await rejected
    expect(emit.mock.calls.some(([event]) => event === 'prompt:expired')).toBe(true)
    expect(hub['sessions'].size).toBe(0)
  })
})
