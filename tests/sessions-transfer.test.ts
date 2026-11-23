import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { SessionHub } from '../src/main/sessions'
import * as sftpOps from '../src/main/sftp/ops'
import * as atomicEdit from '../src/main/sftp/atomic-edit'
import * as sshConnect from '../src/main/ssh/connect'
import { transferPartName } from '../src/core/transfer'
import { shell } from 'electron'
import { startMiniSshd } from './support/mini-sshd.mjs'

const mockTar = vi.hoisted(() => vi.fn<(file: string, args: string[], options: { signal: AbortSignal; env?: NodeJS.ProcessEnv }) => Promise<unknown>>())
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  mockTar.mockImplementation(promisify(actual.execFile))
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: mockTar }) }
})
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

describe('session transfers and remote editing', () => {
  let workspace: string
  let server: Awaited<ReturnType<typeof startMiniSshd>>
  let vault: Vault
  let hub: SessionHub
  let sessionId: string
  let remoteFile: string
  const emit = vi.fn()

  beforeEach(async () => {
    emit.mockClear()
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-edit-'))
    server = await startMiniSshd({ password: 'test', root: path.join(workspace, 'server'), atomicEditFixture: true })
    remoteFile = path.join(server.root, 'readme.txt')
    vault = new Vault(emptyStore(), new MemorySecretCodec())
    const host = vault.saveHost({ groupId: null, name: 'test', host: '127.0.0.1', port: server.port,
      username: 'hop', authType: 'password', password: 'test' })
    const known = new KnownHostFile(path.join(workspace, 'known.json'))
    vi.spyOn(known, 'judge').mockReturnValue('trusted')
    hub = new SessionHub(vault, known, emit, workspace)
    sessionId = (await hub.connect(host.id, 80, 24)).id
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    mockTar.mockClear()
    for (const session of hub?.list() ?? []) await hub.close(session.id)
    await server?.close()
    fs.rmSync(workspace, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function syncAfter(write: () => void) {
    emit.mockClear()
    write()
    await vi.waitFor(() => expect(emit.mock.calls.some(([channel]) => channel === 'edit:synced')).toBe(true),
      { timeout: 8000, interval: 25 })
    return emit.mock.calls.find(([channel]) => channel === 'edit:synced')![1]
  }

  async function openEdit(remote = '/readme.txt') {
    const result = await hub.editRemote(sessionId, remote)
    return result.localPath
  }

  it('atomically replaces same-size and growing edits and advances the baseline', async () => {
    fs.chmodSync(remoteFile, 0o640)
    const before = fs.statSync(remoteFile)
    const local = await openEdit()
    expect(await syncAfter(() => fs.writeFileSync(local, 'Changed\n'))).toEqual({ sessionId, remotePath: '/readme.txt' })
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('Changed\n')
    const firstSave = fs.statSync(remoteFile)
    expect(firstSave.ino).not.toBe(before.ino)
    expect(await syncAfter(() => fs.writeFileSync(local, 'A completely new and longer text\n')))
      .toEqual({ sessionId, remotePath: '/readme.txt' })
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('A completely new and longer text\n')
    const after = fs.statSync(remoteFile)
    expect(after.ino).not.toBe(firstSave.ino)
    expect([after.uid, after.gid, after.mode]).toEqual([before.uid, before.gid, before.mode])
  })

  it.each(['size', 'mtime', 'same-second-same-size', 'deleted'])('refuses to overwrite a remote %s conflict', async (change) => {
    const local = await openEdit()
    const original = fs.statSync(remoteFile)
    if (change === 'deleted') fs.unlinkSync(remoteFile)
    else if (change === 'size') fs.writeFileSync(remoteFile, 'An external change')
    else if (change === 'same-second-same-size') {
      fs.writeFileSync(remoteFile, 'EXTERN!\n')
      fs.utimesSync(remoteFile, original.atime, original.mtime)
      expect(fs.statSync(remoteFile).size).toBe(original.size)
      expect(Math.floor(fs.statSync(remoteFile).mtimeMs / 1000)).toBe(Math.floor(original.mtimeMs / 1000))
    }
    else {
      fs.writeFileSync(remoteFile, 'EXTERN!\n')
      fs.utimesSync(remoteFile, new Date(), new Date(Date.now() + 5000))
    }
    const external = fs.existsSync(remoteFile) ? fs.readFileSync(remoteFile, 'utf8') : null
    expect(await syncAfter(() => fs.writeFileSync(local, 'My new version'))).toEqual({
      sessionId, remotePath: '/readme.txt', conflict: true, error: expect.stringContaining('远端文件已被修改')
    })
    expect(fs.existsSync(remoteFile) ? fs.readFileSync(remoteFile, 'utf8') : null).toBe(external)
  })

  it('rejects an oversized local edit before opening the remote target for writing', async () => {
    const local = await openEdit(), original = fs.readFileSync(remoteFile)
    const write = vi.spyOn(atomicEdit, 'saveAtomicEdit')
    const result = await syncAfter(() => fs.writeFileSync(local, Buffer.alloc(20 * 1024 * 1024 + 1)))
    expect(result.error).toBe('文件超过 20 MB，请改为下载')
    expect(write).not.toHaveBeenCalled()
    expect(fs.readFileSync(remoteFile)).toEqual(original)
  })

  it('keeps local recovery when the atomic helper cannot confirm its committed result', async () => {
    const local = await openEdit()
    vi.spyOn(atomicEdit, 'saveAtomicEdit').mockRejectedValueOnce(new Error('回传后的内容无法确认，已保留本地副本，请重新打开核对'))
    const result = await syncAfter(() => fs.writeFileSync(local, 'My edit'))
    expect(result.error).toBe('回传后的内容无法确认，已保留本地副本，请重新打开核对')
    expect(fs.readFileSync(local, 'utf8')).toBe('My edit')
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('Hopline\n')
  })

  it('refuses hard-linked files before opening the editor', async () => {
    const alias = path.join(server.root, 'hard.txt')
    fs.linkSync(remoteFile, alias)
    const before = fs.statSync(alias)
    vi.mocked(shell.openPath).mockClear()
    await expect(openEdit()).rejects.toThrow()
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(fs.readFileSync(alias, 'utf8')).toBe('Hopline\n')
    expect(fs.statSync(alias).ino).toBe(before.ino)
    expect(fs.readdirSync(server.root).filter(name => name.startsWith('.hopline-edit-'))).toEqual([])
  })

  it('refuses symbolic links before opening the editor', async () => {
    fs.symlinkSync('readme.txt', path.join(server.root, 'link.txt'))
    const before = fs.statSync(remoteFile)
    vi.mocked(shell.openPath).mockClear()
    await expect(openEdit('/link.txt')).rejects.toThrow()
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(fs.lstatSync(path.join(server.root, 'link.txt')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('Hopline\n')
    expect(fs.statSync(remoteFile).ino).toBe(before.ino)
    expect(fs.readdirSync(server.root).filter(name => name.startsWith('.hopline-edit-'))).toEqual([])
  })

  it('refuses an exec/SFTP namespace proof mismatch before opening the editor', async () => {
    const read = atomicEdit.readAtomicEdit
    vi.spyOn(atomicEdit, 'readAtomicEdit').mockImplementationOnce((client, remotePath, signal, proof) =>
      read(client, remotePath, signal, { ...proof, token: 'wrong-namespace' }))
    vi.mocked(shell.openPath).mockClear()
    await expect(openEdit()).rejects.toThrow('无法验证安全保存条件')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('Hopline\n')
    expect(fs.readdirSync(server.root).filter(name => name.startsWith('.hopline-edit-'))).toEqual([])
  })

  it('refreshes an existing same-size cache when reopening', async () => {
    const local = await openEdit()
    fs.writeFileSync(remoteFile, 'EXTERN!\n')
    await openEdit()
    expect(fs.readFileSync(local, 'utf8')).toBe('EXTERN!\n')
  })

  it.each([['symbolic', false], ['hard', false], ['symbolic', true], ['hard', true]] as const)('refuses a %s-linked local cache (unchanged baseline: %s) without changing outside contents', async (kind, unchanged) => {
    const local = await openEdit()
    const outside = path.join(workspace, 'outside.txt')
    fs.writeFileSync(outside, 'Keep outside contents')
    // Stop events to exercise the cache-refresh boundary rather than a prior save.
    await hub['sessions'].get(sessionId)!.watchers.get('/readme.txt')!.watcher!.close()
    fs.unlinkSync(local)
    if (kind === 'symbolic') fs.symlinkSync(outside, local)
    else fs.linkSync(outside, local)
    const outsideMode = fs.statSync(outside).mode
    if (unchanged) {
      const same = fs.statSync(local)
      hub['sessions'].get(sessionId)!.watchers.get('/readme.txt')!.savedLocal = { size: same.size, mtimeMs: same.mtimeMs }
    }
    vi.mocked(shell.openPath).mockClear()
    try {
      await expect(openEdit()).rejects.toThrow()
      expect(shell.openPath).not.toHaveBeenCalled()
      expect(fs.readFileSync(outside, 'utf8')).toBe('Keep outside contents')
      expect(fs.statSync(outside).mode).toBe(outsideMode)
      expect(fs.readFileSync(remoteFile, 'utf8')).toBe('Hopline\n')
    } finally {
      fs.rmSync(local, { force: true })
      if (hub['sessions'].get(sessionId)!.watchers.has('/readme.txt')) {
        fs.mkdirSync(path.dirname(local), { recursive: true })
        fs.writeFileSync(local, 'Hopline\n')
      }
    }
  })

  it('finishes an in-flight save before refreshing the edit cache', async () => {
    const local = await openEdit()
    const original = atomicEdit.saveAtomicEdit
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const save = vi.spyOn(atomicEdit, 'saveAtomicEdit').mockImplementation(async (...args) => {
      await gate
      return await original(...args)
    })
    try {
      fs.writeFileSync(local, 'Pending save')
      hub['sessions'].get(sessionId)!.watchers.get('/readme.txt')!.watcher!.emit('change', local)
      await vi.waitFor(() => expect(save).toHaveBeenCalled())
      const reopening = hub.editRemote(sessionId, '/readme.txt')
      release()
      await reopening
      expect(fs.readFileSync(remoteFile, 'utf8')).toBe('Pending save')
      expect(fs.readFileSync(local, 'utf8')).toBe('Pending save')
    } finally {
      release()
    }
  })

  it('cleans up when the external editor cannot open the file', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('无法打开编辑器')
    await expect(hub.editRemote(sessionId, '/readme.txt')).rejects.toThrow('无法打开编辑器')
    expect(hub['sessions'].get(sessionId)!.watchers.size).toBe(0)
    expect(fs.readdirSync(path.join(workspace, 'watch', sessionId))).toEqual([])
  })

  it('does not recreate edit files when closed during the initial download', async () => {
    const original = atomicEdit.readAtomicEdit
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const download = vi.spyOn(atomicEdit, 'readAtomicEdit').mockImplementation(async (...args) => {
      await gate
      return await original(...args)
    })
    const opening = hub.editRemote(sessionId, '/readme.txt')
    const rejected = expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(download).toHaveBeenCalled())
    const closing = hub.close(sessionId)
    release()
    await Promise.all([closing, rejected])
    expect(fs.existsSync(path.join(workspace, 'watch', sessionId))).toBe(false)
  })

  it('removes watch caches on close and on startup', async () => {
    await openEdit()
    await hub.close(sessionId)
    expect(fs.existsSync(path.join(workspace, 'watch', sessionId))).toBe(false)
    const crashed = path.join(workspace, 'watch', 'crashed', 'secret.txt')
    fs.mkdirSync(path.dirname(crashed), { recursive: true })
    fs.writeFileSync(crashed, 'secret')
    new SessionHub(vault, new KnownHostFile('unused'), emit, workspace)
    expect(fs.existsSync(path.join(workspace, 'watch'))).toBe(false)
  })

  it('persists an atomic private edit manifest on open, dirty changes and successful saves', async () => {
    const local = await openEdit()
    const manifest = path.join(path.dirname(local), '.hopline-edit.json')
    const read = () => JSON.parse(fs.readFileSync(manifest, 'utf8'))
    expect(read()).toMatchObject({ remotePath: '/readme.txt', hostId: hub.list()[0]!.hostId,
      dirty: false, savedLocal: { size: fs.statSync(local).size, mtimeMs: fs.statSync(local).mtimeMs } })
    expect(fs.statSync(manifest).mode & 0o777).toBe(0o600)
    vi.spyOn(atomicEdit, 'saveAtomicEdit').mockRejectedValueOnce(new Error('保存失败'))
    await syncAfter(() => fs.writeFileSync(local, 'Unsaved content'))
    expect(read()).toMatchObject({ dirty: true, error: '保存失败' })
    await syncAfter(() => fs.writeFileSync(local, 'Successful save'))
    expect(read()).toMatchObject({ dirty: false,
      savedLocal: { size: fs.statSync(local).size, mtimeMs: fs.statSync(local).mtimeMs } })
    expect(read().error).toBeUndefined()
    expect(fs.readdirSync(path.dirname(local)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps the previous manifest intact when its atomic replacement fails', async () => {
    const local = await openEdit()
    const manifest = path.join(path.dirname(local), '.hopline-edit.json')
    const previous = fs.readFileSync(manifest, 'utf8')
    const originalRename = fs.renameSync
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === manifest) throw new Error('清单写入失败')
      originalRename(from, to)
    })
    try {
      const result = await syncAfter(() => fs.writeFileSync(local, 'Unsaved content'))
      expect(result.error).toBe('清单写入失败')
      expect(fs.readFileSync(manifest, 'utf8')).toBe(previous)
      expect(fs.readFileSync(local, 'utf8')).toBe('Unsaved content')
    } finally {
      rename.mockRestore()
    }
  })

  it.each(['.hopline-edit.json', '.hopline-edit.json.tmp'])('edits and recovers a remote file named %s without overwriting metadata', async (name) => {
    const remote = `/${name}`
    const file = path.join(server.root, name)
    fs.writeFileSync(file, 'Remote contents')
    const local = await openEdit(remote)
    expect(fs.readFileSync(local, 'utf8')).toBe('Remote contents')
    await syncAfter(() => fs.writeFileSync(local, 'Saved contents'))
    expect(fs.readFileSync(file, 'utf8')).toBe('Saved contents')
    fs.writeFileSync(local, 'Unsent before crash')
    const startup = path.join(workspace, 'startup')
    fs.cpSync(path.join(workspace, 'watch'), path.join(startup, 'watch'), { recursive: true, preserveTimestamps: true })
    const restarted = new SessionHub(vault, new KnownHostFile('unused'), emit, startup)
    expect(restarted.startupRecovered).toHaveLength(1)
    expect(fs.readFileSync(restarted.startupRecovered[0]!, 'utf8')).toBe('Unsent before crash')
  })

  it('recovers dirty and changed startup edits while deleting clean copies', () => {
    const startup = path.join(workspace, 'startup')
    const make = (name: string, dirty: boolean) => {
      const dir = path.join(startup, 'watch', 'old-session', name)
      fs.mkdirSync(dir, { recursive: true })
      const local = path.join(dir, `${name}.txt`)
      fs.writeFileSync(local, name)
      const stat = fs.statSync(local)
      fs.writeFileSync(path.join(dir, '.hopline-edit.json'), JSON.stringify({
        remotePath: `/${name}.txt`, hostId: 'old-host', dirty,
        savedLocal: { size: stat.size, mtimeMs: stat.mtimeMs }
      }))
      return local
    }
    make('dirty', true)
    make('clean', false)
    fs.writeFileSync(make('changed', false), 'Changed before watcher noticed')
    const changedTime = make('mtime', false)
    fs.utimesSync(changedTime, new Date(), new Date(fs.statSync(changedTime).mtimeMs + 5000))
    emit.mockClear()
    const restarted = new SessionHub(vault, new KnownHostFile('unused'), emit, startup)
    const recovered = restarted.startupRecovered
    expect(recovered).toHaveLength(3)
    expect(recovered.map((file) => fs.readFileSync(file, 'utf8')).sort()).toEqual(['Changed before watcher noticed', 'dirty', 'mtime'])
    for (const file of recovered) expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(startup, 'recovered')).mode & 0o777).toBe(0o700)
    expect(fs.existsSync(path.join(startup, 'watch'))).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it.each(['missing', 'broken', 'invalid'])('recovers startup files with a %s manifest', (state) => {
    const startup = path.join(workspace, 'startup')
    const dir = path.join(startup, 'watch', 'old-session', 'edit')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'Do not delete')
    if (state !== 'missing') fs.writeFileSync(path.join(dir, '.hopline-edit.json'), state === 'broken' ? '{bad' : '{}')
    const restarted = new SessionHub(vault, new KnownHostFile('unused'), emit, startup)
    const recovered = restarted.startupRecovered
    expect(recovered).toHaveLength(1)
    expect(fs.readFileSync(recovered[0]!, 'utf8')).toBe('Do not delete')
    expect(fs.existsSync(path.join(startup, 'watch'))).toBe(false)
  })

  it('starts without deleting startup copies when recovery fails and recovers them on retry', () => {
    const startup = path.join(workspace, 'startup')
    const local = path.join(startup, 'watch', 'old-session', 'edit', 'secret.txt')
    fs.mkdirSync(path.dirname(local), { recursive: true })
    fs.writeFileSync(local, 'Keep this copy')
    fs.writeFileSync(path.join(startup, 'recovered'), 'Not a directory')
    const failed = new SessionHub(vault, new KnownHostFile('unused'), emit, startup)
    expect(failed.startupRecoveryFailed).toBe(path.join(startup, 'watch'))
    expect(failed.startupRecovered).toEqual([])
    expect(fs.readFileSync(local, 'utf8')).toBe('Keep this copy')
    fs.unlinkSync(path.join(startup, 'recovered'))
    const restarted = new SessionHub(vault, new KnownHostFile('unused'), emit, startup)
    expect(restarted.startupRecoveryFailed).toBeNull()
    expect(fs.readFileSync(restarted.startupRecovered[0]!, 'utf8')).toBe('Keep this copy')
  })

  it('closeAll resolves only after every session has closed', async () => {
    const host = vault.listHosts()[0]!
    const second = (await hub.connect(host.id, 80, 24)).id
    await hub.closeAll()
    expect(hub.list()).toEqual([])
    expect(second).not.toBe(sessionId)
  })

  it('confirms each remote directory only once per concurrent upload batch', async () => {
    vault.updateSettings({ transferConcurrency: 4, packSmallFiles: false })
    await hub.sftpList(sessionId, '/')
    const stat = vi.spyOn(hub['sessions'].get(sessionId)!.sftp!, 'stat')
    const files = Array.from({ length: 20 }, (_, i) => {
      const file = path.join(workspace, `file-${i}.txt`)
      fs.writeFileSync(file, `content-${i}`)
      return file
    })
    await hub.upload(sessionId, files, '/nested/deep')
    await vi.waitFor(() => expect(hub.jobsFor(sessionId).map((job) => job.status)).toEqual(files.map(() => 'done')))
    expect(stat.mock.calls.filter(([file]) => file === '/nested')).toHaveLength(1)
    expect(stat.mock.calls.filter(([file]) => file === '/nested/deep')).toHaveLength(1)
  })

  it('reports a failed reconnect and ignores late events from the old connection', async () => {
    const session = hub['sessions'].get(sessionId)!
    const old = session.lease!.client
    const shell = session.shell!
    await hub.reconnect(sessionId, 80, 24)
    old.emit('error', new Error('late old error'))
    old.emit('close')
    shell.emit('close')
    shell.emit('error', new Error('late shell error'))
    expect(hub.list()[0]?.status).toBe('connected')
    vi.spyOn(vault, 'getHost').mockReturnValue(undefined)
    await expect(hub.reconnect(sessionId, 80, 24)).rejects.toThrow('主机不存在')
    expect(hub.list()[0]).toMatchObject({ status: 'error', message: '主机不存在' })
    expect(emit).toHaveBeenCalledWith('ssh:status', expect.objectContaining({ status: 'error', message: '主机不存在' }))
  })

  it.each(['/readme.txt', '/notes'])('uses the new SFTP handle for queued downloads of %s', async (remote) => {
    const session = hub['sessions'].get(sessionId)!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vault.updateSettings({ transferConcurrency: 1 })
    session.queue.setConcurrency(1)
    session.queue.enqueue({ id: 'blocker', run: () => gate })
    try {
      await hub.download(sessionId, remote, workspace)
      expect(hub.jobsFor(sessionId)[0]?.status).toBe('queued')
      await hub.reconnect(sessionId, 80, 24)
      release()
      await vi.waitFor(() => expect(hub.jobsFor(sessionId)[0]?.status).toBe('done'))
      const target = remote === '/notes' ? 'notes/today.txt' : 'readme.txt'
      expect(fs.readFileSync(path.join(workspace, target))).toEqual(fs.readFileSync(path.join(server.root, target)))
    } finally {
      release()
    }
  })

  it('removes completed and cancelled session jobs on close', async () => {
    await hub.download(sessionId, '/readme.txt', workspace)
    await vi.waitFor(() => expect(hub.jobsFor(sessionId)[0]?.status).toBe('done'))
    await hub.close(sessionId)
    expect(hub.jobsFor(sessionId)).toEqual([])
  })

  it.each(['close', 'reopen'])('recovers conflicted edits on %s', async (action) => {
    const local = await openEdit()
    fs.writeFileSync(remoteFile, 'Externally modified content')
    await syncAfter(() => fs.writeFileSync(local, 'My unsaved changes'))
    if (action === 'close') await hub.close(sessionId)
    else await hub.editRemote(sessionId, '/readme.txt')
    const recovered = emit.mock.calls.find(([channel, payload]) => channel === 'edit:synced' && payload.recoveredPath)?.[1]
    expect(recovered).toMatchObject({ sessionId, remotePath: '/readme.txt', conflict: true,
      recoveredPath: expect.any(String), error: expect.any(String) })
    expect(fs.readFileSync(recovered.recoveredPath, 'utf8')).toBe('My unsaved changes')
    expect(fs.statSync(path.join(workspace, 'recovered')).mode & 0o777).toBe(0o700)
    expect(fs.statSync(recovered.recoveredPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('Externally modified content')
    if (action === 'close') expect(fs.existsSync(path.join(workspace, 'watch', sessionId))).toBe(false)
    else expect(fs.readFileSync(local, 'utf8')).toBe('Externally modified content')
  })

  it.each(['close', 'reopen'])('recovers failed saves on %s', async (action) => {
    const local = await openEdit()
    vi.spyOn(atomicEdit, 'saveAtomicEdit').mockRejectedValueOnce(new Error('回传连接断开'))
    expect(await syncAfter(() => fs.writeFileSync(local, 'Failed save contents')))
      .toMatchObject({ error: '回传连接断开' })
    if (action === 'close') await hub.close(sessionId)
    else await hub.editRemote(sessionId, '/readme.txt')
    const recovered = emit.mock.calls.find(([channel, payload]) => channel === 'edit:synced' && payload.recoveredPath)?.[1]
    expect(recovered).toMatchObject({ error: expect.stringContaining('回传连接断开'), recoveredPath: expect.any(String) })
    expect(fs.readFileSync(recovered.recoveredPath, 'utf8')).toBe('Failed save contents')
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('Hopline\n')
  })

  it('clears unsynced changes after a successful retry', async () => {
    const local = await openEdit()
    vi.spyOn(atomicEdit, 'saveAtomicEdit').mockRejectedValueOnce(new Error('回传连接断开'))
    await syncAfter(() => fs.writeFileSync(local, 'Failed save contents'))
    expect(await syncAfter(() => fs.writeFileSync(local, 'Successful retry'))).toEqual({ sessionId, remotePath: '/readme.txt' })
    await hub.close(sessionId)
    expect(fs.existsSync(path.join(workspace, 'recovered'))).toBe(false)
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('Successful retry')
  })

  it('does not overwrite an earlier recovery with the same timestamp and filename', async () => {
    const local = await openEdit()
    fs.writeFileSync(remoteFile, 'External edit')
    await syncAfter(() => fs.writeFileSync(local, 'Unsynced edit'))
    const recovered = path.join(workspace, 'recovered')
    fs.mkdirSync(recovered)
    const previous = path.join(recovered, '20261027120000-readme.txt')
    fs.writeFileSync(previous, 'Earlier recovery')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00'))
    try {
      await hub.close(sessionId)
    } finally {
      vi.useRealTimers()
    }
    expect(fs.readFileSync(previous, 'utf8')).toBe('Earlier recovery')
    expect(fs.readFileSync(path.join(recovered, '20261027120000-1-readme.txt'), 'utf8')).toBe('Unsynced edit')
  })

  it.each(['close', 'reopen'])('preserves the cache when recovery fails on %s', async (action) => {
    const local = await openEdit()
    fs.writeFileSync(remoteFile, 'External edit')
    await syncAfter(() => fs.writeFileSync(local, 'Unsynced edit'))
    const obstruction = path.join(workspace, 'recovered')
    fs.writeFileSync(obstruction, 'Not a directory')
    try {
      await expect(action === 'close' ? hub.close(sessionId) : hub.editRemote(sessionId, '/readme.txt')).rejects.toThrow()
      expect(fs.readFileSync(local, 'utf8')).toBe('Unsynced edit')
    } finally {
      fs.unlinkSync(obstruction)
    }
    if (action === 'close') {
      expect(hub.list()).toEqual([expect.objectContaining({ id: sessionId, status: 'error' })])
      expect(hub['sessions'].get(sessionId)!.sftp).toBeUndefined()
      await hub.close(sessionId)
      const recovered = emit.mock.calls.find(([channel, payload]) => channel === 'edit:synced' && payload.recoveredPath)?.[1]
      expect(fs.readFileSync(recovered.recoveredPath, 'utf8')).toBe('Unsynced edit')
    }
  })

  it('recovers edits closed before the filesystem watcher debounce finishes', async () => {
    const local = await openEdit()
    fs.writeFileSync(local, 'Quickly saved then closed')
    await hub.close(sessionId)
    const recovered = emit.mock.calls.find(([channel, payload]) => channel === 'edit:synced' && payload.recoveredPath)?.[1]
    expect(fs.readFileSync(recovered.recoveredPath, 'utf8')).toBe('Quickly saved then closed')
  })

  it('scans the upload directory once for a batch of 200 files and removes obsolete parts', async () => {
    vault.updateSettings({ transferConcurrency: 4, packSmallFiles: false })
    await hub.sftpList(sessionId, '/')
    const sftp = hub['sessions'].get(sessionId)!.sftp!
    const readdir = vi.spyOn(sftp, 'readdir')
    const files = Array.from({ length: 200 }, (_, i) => {
      const name = `small-${i}.txt`
      const file = path.join(workspace, name)
      fs.writeFileSync(file, `content-${i}`)
      fs.writeFileSync(path.join(server.root, transferPartName(name, 1, 0)), 'x')
      return file
    })
    await hub.upload(sessionId, files, '/')
    await vi.waitFor(() => expect(hub.jobsFor(sessionId).every((job) => job.status === 'done')).toBe(true),
      { timeout: 10_000 })
    // ssh2 invokes readdir again with a handle for each protocol page.
    expect(readdir.mock.calls.filter(([target]) => typeof target === 'string')).toHaveLength(1)
    expect(readdir.mock.calls.length).toBeLessThanOrEqual(6)
    expect(fs.readdirSync(server.root).filter((name) => name.endsWith('.hopline-part'))).toEqual([])
    for (const file of files) expect(fs.readFileSync(path.join(server.root, path.basename(file)))).toEqual(fs.readFileSync(file))
  })

  it('scans the local download directory once for a batch of 200 files', async () => {
    vault.updateSettings({ transferConcurrency: 4 })
    const source = path.join(server.root, 'batch')
    const target = path.join(workspace, 'downloads', 'batch')
    fs.mkdirSync(source)
    fs.mkdirSync(target, { recursive: true })
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(source, `small-${i}.txt`), `content-${i}`)
      fs.writeFileSync(path.join(target, transferPartName(`small-${i}.txt`, 1, 0)), 'x')
    }
    const readdir = vi.spyOn(fs.promises, 'readdir')
    await hub.download(sessionId, '/batch', path.dirname(target))
    await vi.waitFor(() => expect(hub.jobsFor(sessionId).every((job) => job.status === 'done')).toBe(true),
      { timeout: 10_000 })
    expect(readdir.mock.calls.filter(([dir]) => dir === fs.realpathSync(target))).toHaveLength(1)
    expect(fs.readdirSync(target).filter((name) => name.endsWith('.hopline-part'))).toEqual([])
    for (let i = 0; i < 200; i++) expect(fs.readFileSync(path.join(target, `small-${i}.txt`), 'utf8')).toBe(`content-${i}`)
  })

  it.each(['upload files', 'upload directory', 'download'] as const)('runs queued %s tasks even when they start during reconnect', async (direction) => {
    vault.updateSettings({ transferConcurrency: 1, packSmallFiles: false })
    const source = path.join(direction === 'download' ? server.root : workspace, 'batch')
    fs.mkdirSync(source)
    const files = Array.from({ length: 3 }, (_, i) => {
      const file = path.join(source, `file-${i}.txt`)
      fs.writeFileSync(file, `content-${i}`)
      return file
    })
    let releaseFirst!: () => void
    let releaseConnection!: () => void
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const connecting = new Promise<void>((resolve) => { releaseConnection = resolve })
    const transfer = vi.spyOn(sftpOps, direction === 'download' ? 'downloadFile' : 'uploadFile')
      .mockImplementationOnce(async () => { await first; throw new Error('旧连接已断开') })
    const originalConnect = sshConnect.connectEndpoint
    try {
      if (direction === 'download') await hub.download(sessionId, '/batch', path.join(workspace, 'downloads'))
      else await hub.upload(sessionId, direction === 'upload files' ? files : [source], '/')
      await vi.waitFor(() => expect(transfer).toHaveBeenCalledTimes(1))
      vi.spyOn(sshConnect, 'connectEndpoint').mockImplementationOnce(async (...args) => {
        await connecting
        return originalConnect(...args)
      })
      const reconnected = hub.reconnect(sessionId, 80, 24)
      releaseFirst()
      await vi.waitFor(() => expect(hub.jobsFor(sessionId)[1]?.status).toBe('running'))
      expect(transfer).toHaveBeenCalledTimes(1)
      releaseConnection()
      await reconnected
      await vi.waitFor(() => expect(hub.jobsFor(sessionId).slice(1).map((job) => job.status)).toEqual(['done', 'done']))
      const target = direction === 'download' ? path.join(workspace, 'downloads', 'batch')
        : direction === 'upload directory' ? path.join(server.root, 'batch') : server.root
      for (const i of [1, 2]) expect(fs.readFileSync(path.join(target, `file-${i}.txt`), 'utf8')).toBe(`content-${i}`)
    } finally {
      releaseFirst()
      releaseConnection()
    }
  })

  it('initializes SFTP for a queued packed upload after reconnect', async () => {
    vault.updateSettings({ transferConcurrency: 1, packSmallFiles: true })
    const source = path.join(workspace, 'packed')
    fs.mkdirSync(source)
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(source, `file-${i}.txt`), `content-${i}`)
    const session = hub['sessions'].get(sessionId)!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    session.queue.setConcurrency(1)
    session.queue.enqueue({ id: 'blocker', run: () => gate })
    try {
      // Relative paths also work with the mini server's exec working directory.
      await hub.upload(sessionId, [source], '.')
      expect(hub.jobsFor(sessionId)[0]?.status).toBe('queued')
      await hub.reconnect(sessionId, 80, 24)
      release()
      await vi.waitFor(() => expect(hub.jobsFor(sessionId)[0]?.status).toBe('done'), { timeout: 5000 })
      for (let i = 0; i < 12; i++) expect(fs.readFileSync(path.join(server.root, 'packed', `file-${i}.txt`), 'utf8')).toBe(`content-${i}`)
    } finally {
      release()
    }
  })

  it('packs darwin directory uploads without xattrs or macOS metadata and scopes COPYFILE_DISABLE to tar', async () => {
    const source = path.join(workspace, 'mac-packed')
    fs.mkdirSync(source)
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(source, `file-${i}.txt`), `content-${i}`)
    const nativePlatform = process.platform
    if (nativePlatform === 'darwin') {
      execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0083;00000000;HopLineTest;', path.join(source, 'file-0.txt')])
      execFileSync('/usr/bin/xattr', ['-w', 'com.apple.metadata:hopline-fixture', 'fixture', path.join(source, 'file-0.txt')])
    }
    const originalCopyfile = process.env.COPYFILE_DISABLE
    mockTar.mockImplementationOnce(async (file, args, options) => {
      expect(file).toBe('tar')
      expect(args.slice(2, 4)).toEqual(['--no-xattrs', '--no-mac-metadata'])
      expect(options.env?.COPYFILE_DISABLE).toBe('1')
      expect(options.env?.PATH).toBe(process.env.PATH)
      const nativeArgs = nativePlatform === 'darwin' ? args : args.filter(arg => !['--no-xattrs', '--no-mac-metadata'].includes(arg))
      execFileSync(file, nativeArgs, { env: options.env })
      const archive = gunzipSync(fs.readFileSync(args[1]!)).toString('latin1')
      expect(archive).not.toMatch(/com\.apple\.|SCHILY\.xattr|LIBARCHIVE\.xattr/)
    })
    vault.updateSettings({ packSmallFiles: true })
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }))
    await hub.upload(sessionId, [source], '.')
    const job = () => hub.jobsFor(sessionId)[0]
    await vi.waitFor(() => expect(job()?.status, job()?.error).toBe('done'))
    expect(mockTar).toHaveBeenCalledOnce()
    expect(process.env.COPYFILE_DISABLE).toBe(originalCopyfile)
    for (let i = 0; i < 12; i++) expect(fs.readFileSync(path.join(server.root, 'mac-packed', `file-${i}.txt`), 'utf8')).toBe(`content-${i}`)
  })

  it.each(['ENOENT', 'EACCES', 1])('falls back on Windows only when tar.exe is missing (code %s)', async (code) => {
    const source = path.join(workspace, 'packed')
    fs.mkdirSync(path.join(source, 'nested', 'empty'), { recursive: true })
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(source, `file-${i}.txt`), `content-${i}`)
    vault.updateSettings({ packSmallFiles: true })
    mockTar.mockRejectedValueOnce(Object.assign(new Error('tar failed'), { code }))
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))

    await hub.upload(sessionId, [source], '.')
    const expected = code === 'ENOENT' ? 'done' : 'error'
    const job = () => hub.jobsFor(sessionId)[0]
    await vi.waitFor(() => expect(job()?.status).toBe(expected))
    expect(mockTar).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\\System32\\tar\.exe$/i), expect.any(Array), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const target = path.join(server.root, 'packed')
    if (code === 'ENOENT') {
      expect(fs.readdirSync(path.join(target, 'nested', 'empty'))).toEqual([])
      for (let i = 0; i < 12; i++) expect(fs.readFileSync(path.join(target, `file-${i}.txt`), 'utf8')).toBe(`content-${i}`)
    } else {
      expect(job()?.error).toBe('tar failed')
      expect(fs.existsSync(target)).toBe(false)
    }
  })

  it.skipIf(process.platform === 'win32')('publishes normalized Windows archive modes without changing unrelated remote entries', async () => {
    const name = "-目录'包"
    const source = path.join(workspace, name)
    const remote = "remote 'folder'"
    const target = path.join(server.root, remote, name)
    const longName = 'a'.repeat(105) + '.txt'
    fs.mkdirSync(path.join(source, 'empty'), { recursive: true })
    fs.chmodSync(source, 0o777)
    fs.chmodSync(path.join(source, 'empty'), 0o775)
    fs.writeFileSync(path.join(source, longName), 'new content')
    fs.chmodSync(path.join(source, longName), 0o777)
    for (let i = 0; i < 11; i++) fs.writeFileSync(path.join(source, `file-${i}.txt`), `content-${i}`)
    fs.mkdirSync(target, { recursive: true })
    fs.chmodSync(target, 0o777)
    fs.writeFileSync(path.join(target, 'keep.txt'), 'existing content', { mode: 0o600 })
    vault.updateSettings({ packSmallFiles: true })

    const hostPlatform = process.platform
    mockTar.mockImplementationOnce(async (_file, args) => {
      const tarArgs = hostPlatform === 'darwin' ? args : [...args.slice(0, 2), '--format', 'gnu', ...args.slice(6)]
      execFileSync('tar', tarArgs)
    })
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))

    await hub.upload(sessionId, [source], remote)
    const job = () => hub.jobsFor(sessionId)[0]
    await vi.waitFor(() => expect(job()?.status, job()?.error).toBe('done'))
    expect(fs.statSync(target).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.join(target, 'empty')).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.join(target, longName)).mode & 0o777).toBe(0o644)
    expect(fs.readFileSync(path.join(target, longName), 'utf8')).toBe('new content')
    expect(fs.statSync(path.join(target, 'keep.txt')).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.join(server.root, remote))).toEqual([name])
  })

  it('cancels running and queued jobs without recreating them after close', async () => {
    const session = hub['sessions'].get(sessionId)!
    const run = ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    vault.updateSettings({ transferConcurrency: 1 })
    for (let i = 0; i < 2; i++) {
      hub['enqueue'](session, { direction: 'download', name: `job-${i}`, localPath: workspace,
        remotePath: '/readme.txt', total: 8, run })
    }
    expect(hub.jobsFor(sessionId).map((job) => job.status)).toEqual(['running', 'queued'])
    await hub.close(sessionId)
    await Promise.resolve()
    expect(hub.jobsFor(sessionId)).toEqual([])
    expect(session.queue.list().map((job) => job.status)).toEqual(['cancelled', 'cancelled'])
  })
})
