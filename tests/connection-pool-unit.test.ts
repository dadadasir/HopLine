import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { SessionHub } from '../src/main/sessions'
import * as sshConnect from '../src/main/ssh/connect'
import * as sshExec from '../src/main/ssh/exec'
import * as sftpOps from '../src/main/sftp/ops'
import { ConnectionPool } from '../src/main/ssh/pool'

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  write = vi.fn()
  end = vi.fn((_input: string) => {})
  close = vi.fn(() => { this.emit('close') })
  setWindow = vi.fn()
  get channel() { return this as unknown as ClientChannel }
}

class Connection extends EventEmitter {
  shells: Channel[] = []
  sftps: { end: ReturnType<typeof vi.fn> }[] = []
  end = vi.fn(() => { this.emit('close') })
  shell = vi.fn((_options: unknown, callback: (error: undefined, channel: ClientChannel) => void) => {
    const channel = new Channel()
    this.shells.push(channel)
    callback(undefined, channel.channel)
  })
  sftp = vi.fn((callback: (error: undefined, sftp: SFTPWrapper) => void) => {
    const sftp = { end: vi.fn() }
    this.sftps.push(sftp)
    callback(undefined, sftp as unknown as SFTPWrapper)
  })
  exec = vi.fn((_script: string, callback: (error: Error | undefined, channel?: ClientChannel) => void) => {
    callback(undefined, new Channel().channel)
  })
  get client() { return this as unknown as Client }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

let workspace: string
let vault: Vault
let hostId: string
let pool: ConnectionPool
let connections: Connection[]
let hubs: SessionHub[]
const verifyHost = vi.fn(async () => true)
const keyboard = vi.fn(async () => ['密码'])

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-pool-unit-'))
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  hostId = vault.saveHost({ groupId: null, name: '测试主机', host: 'example.test', port: 22,
    username: 'hop', authType: 'password', password: 'test', startupCommand: 'echo 初始化' }).id
  connections = []
  hubs = []
  verifyHost.mockClear()
  keyboard.mockClear()
  vi.spyOn(sshConnect, 'connectEndpoint').mockImplementation(async () => {
    const connection = new Connection()
    connections.push(connection)
    return { client: connection.client, jumps: [] }
  })
  pool = new ConnectionPool(vault, { idleMs: 100, verifyHost, onKeyboard: keyboard })
})

afterEach(async () => {
  for (const hub of hubs) { await hub.closeAll(); await hub.pool.closeAll() }
  await pool.closeAll()
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(workspace, { recursive: true, force: true })
})

function makeHub() {
  const known = new KnownHostFile(path.join(workspace, 'known.json'))
  const hub = new SessionHub(vault, known, vi.fn(), workspace)
  hubs.push(hub)
  return hub
}

describe('connection pool without sockets', () => {
  it.each([
    { connectionTimeoutSec: null, keepaliveIntervalSec: null },
    { connectionTimeoutSec: 37, keepaliveIntervalSec: 43 },
    { connectionTimeoutSec: 5, keepaliveIntervalSec: 0 }
  ])('passes destination connection settings to SSH: %j', async (settings) => {
    vault.saveHost({ ...vault.getHost(hostId)!, ...settings,
      jumps: [{ host: 'jump.test', port: 22, username: 'hop', authType: 'password' }] })
    const lease = await pool.acquire(hostId)
    expect(sshConnect.connectEndpoint).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(settings), expect.objectContaining({ jumps: [expect.objectContaining({ host: 'jump.test' })] })
    )
    const jump = vi.mocked(sshConnect.connectEndpoint).mock.calls[0]![1].jumps![0]!
    expect(jump).not.toHaveProperty('connectionTimeoutSec')
    expect(jump).not.toHaveProperty('keepaliveIntervalSec')
    lease.release()
  })

  it('applies updated connection settings to a new connection while keeping an active lease alive', async () => {
    const old = await pool.acquire(hostId)
    const settings = { connectionTimeoutSec: 12, keepaliveIntervalSec: 0 }
    vault.saveHost({ ...vault.getHost(hostId)!, ...settings })
    pool.invalidate(hostId)
    const fresh = await pool.acquire(hostId)
    expect(fresh.client).not.toBe(old.client)
    expect(sshConnect.connectEndpoint).toHaveBeenLastCalledWith(expect.objectContaining(settings), expect.anything())
    expect(connections[0]!.end).not.toHaveBeenCalled()
    old.release()
    expect(connections[0]!.end).toHaveBeenCalledOnce()
    fresh.release()
  })

  it('a/b: shares sequential and concurrent acquisitions, including authentication prompts', async () => {
    const gate = deferred<void>()
    const connection = new Connection()
    vi.mocked(sshConnect.connectEndpoint).mockImplementationOnce(async (_target, options) => {
      await options.verifyHost({ host: 'example.test', port: 22, fingerprint: 'key', keyType: 'ed25519' })
      await options.onKeyboard({ name: '', instructions: '', prompts: [{ prompt: '密码', echo: false }] })
      await gate.promise
      return { client: connection.client, jumps: [] }
    })
    const pending = [pool.acquire(hostId), pool.acquire(hostId), pool.acquire(hostId)]
    gate.resolve()
    const leases = await Promise.all(pending)
    leases.push(await pool.acquire(hostId))
    expect(new Set(leases.map((lease) => lease.client)).size).toBe(1)
    expect(sshConnect.connectEndpoint).toHaveBeenCalledTimes(1)
    expect(verifyHost).toHaveBeenCalledTimes(1)
    expect(keyboard).toHaveBeenCalledTimes(1)
    leases.forEach((lease) => lease.release())
  })

  it.each([
    { socket: '/agent/new.sock' }, { identityFile: '~/.ssh/selected.pub' }, { forward: true }
  ])('passes changed agent config after the existing invalidation flow: %j', async (change) => {
    const initial = { socket: null, identityFile: null, forward: false }
    vault.saveHost({ ...vault.getHost(hostId)!, authType: 'agent', agent: initial,
      jumps: [{ host: 'jump.test', port: 22, username: 'hop', authType: 'agent' }]
    })
    const old = await pool.acquire(hostId)
    const changed = { ...initial, ...change }
    vault.saveHost({ ...vault.getHost(hostId)!, agent: changed })
    pool.invalidate(hostId)
    const fresh = await pool.acquire(hostId)
    expect(fresh.client).not.toBe(old.client)
    expect(sshConnect.connectEndpoint).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ authType: 'agent', agent: changed }) }),
      expect.objectContaining({ jumps: [expect.objectContaining({ auth: expect.objectContaining({ authType: 'agent' }) })] })
    )
    const jumpAuth = vi.mocked(sshConnect.connectEndpoint).mock.calls.at(-1)![1].jumps![0]!.auth
    expect(jumpAuth.agent).toBeNull()
    expect(connections[0]!.end).not.toHaveBeenCalled()
    old.release()
    expect(connections[0]!.end).toHaveBeenCalledTimes(1)
    fresh.release()
  })

  it('c: cancels idle eviction on reuse and makes release idempotent', async () => {
    vi.useFakeTimers()
    const first = await pool.acquire(hostId)
    first.release()
    first.release()
    await vi.advanceTimersByTimeAsync(99)
    const second = await pool.acquire(hostId)
    expect(second.client).toBe(first.client)
    await vi.advanceTimersByTimeAsync(101)
    expect(connections[0]!.end).not.toHaveBeenCalled()
    second.release()
    await vi.advanceTimersByTimeAsync(100)
    expect(connections[0]!.end).toHaveBeenCalledTimes(1)
    expect((await pool.acquire(hostId)).client).not.toBe(first.client)
  })

  it('d: fans out the same connection error and permits retry', async () => {
    const error = new Error('认证失败')
    vi.mocked(sshConnect.connectEndpoint).mockRejectedValueOnce(error)
    const results = await Promise.allSettled([pool.acquire(hostId), pool.acquire(hostId), pool.acquire(hostId)])
    expect(results).toEqual(Array.from({ length: 3 }, () => ({ status: 'rejected', reason: error })))
    expect(sshConnect.connectEndpoint).toHaveBeenCalledTimes(1)
    await expect(pool.acquire(hostId)).resolves.toHaveProperty('hostId', hostId)
    expect(sshConnect.connectEndpoint).toHaveBeenCalledTimes(2)
  })

  it.each(['close', 'error'])('e: reports %s once per lease and ignores old generation events', async (event) => {
    const leases = await Promise.all([pool.acquire(hostId), pool.acquire(hostId), pool.acquire(hostId)])
    const drops = leases.map((lease) => { const notify = vi.fn(); lease.onDrop(notify); return notify })
    const unsubscribed = vi.fn()
    leases[0]!.onDrop(unsubscribed)()
    connections[0]!.emit(event, new Error('断线'))
    const fresh = await pool.acquire(hostId)
    const newDrop = vi.fn()
    fresh.onDrop(newDrop)
    connections[0]!.emit('error', new Error('迟到的错误'))
    connections[0]!.emit('close')
    drops.forEach((notify) => expect(notify).toHaveBeenCalledExactlyOnceWith('连接已断开'))
    expect(unsubscribed).not.toHaveBeenCalled()
    expect(newDrop).not.toHaveBeenCalled()
    expect((await pool.acquire(hostId)).client).toBe(fresh.client)
  })

  it.each(['invalidate', 'fresh', 'invalidateAll'] as const)('f: %s retires the old connection only after all leases release', async (action) => {
    const old = await pool.acquire(hostId)
    const oldAgain = await pool.acquire(hostId)
    const drop = vi.fn()
    old.onDrop(drop)
    vault.saveHost({ ...vault.getHost(hostId)!, host: 'new.test', password: 'new-secret' })
    if (action === 'invalidate') pool.invalidate(hostId)
    if (action === 'invalidateAll') pool.invalidateAll()
    const fresh = await pool.acquire(hostId, { fresh: action === 'fresh' })
    expect(fresh.client).not.toBe(old.client)
    expect(sshConnect.connectEndpoint).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'new.test',
      auth: expect.objectContaining({ password: 'new-secret' }) }), expect.anything())
    expect(connections[0]!.end).not.toHaveBeenCalled()
    old.release()
    expect(connections[0]!.end).not.toHaveBeenCalled()
    oldAgain.release()
    expect(connections[0]!.end).toHaveBeenCalledTimes(1)
    expect(drop).not.toHaveBeenCalled()
  })

  it('preserves an acquisition already in flight when invalidated', async () => {
    const gate = deferred<sshConnect.OpenedConnection>()
    const oldConnection = new Connection()
    vi.mocked(sshConnect.connectEndpoint).mockReturnValueOnce(gate.promise)
    const oldPending = pool.acquire(hostId)
    await Promise.resolve()
    pool.invalidate(hostId)
    const fresh = await pool.acquire(hostId)
    gate.resolve({ client: oldConnection.client, jumps: [] })
    const old = await oldPending
    expect(old.client).not.toBe(fresh.client)
    expect(oldConnection.end).not.toHaveBeenCalled()
    old.release()
    expect(oldConnection.end).toHaveBeenCalledTimes(1)
  })

  it.each([0, 1, 2].flatMap((index) => ['close', 'error'].map((event) => [index, event] as const)))(
    'drops and reconnects when jump %s emits %s, closing every hop once', async (index, event) => {
      const target = new Connection()
      const jumps = [new Connection(), new Connection(), new Connection()]
      vi.mocked(sshConnect.connectEndpoint).mockResolvedValueOnce({ client: target.client, jumps: jumps.map((jump) => jump.client) })
      const leases = await Promise.all([pool.acquire(hostId), pool.acquire(hostId)])
      const drops = leases.map((lease) => { const drop = vi.fn(); lease.onDrop(drop); return drop })
      jumps[index]!.emit(event, new Error('跳板断开'))
      drops.forEach((drop) => expect(drop).toHaveBeenCalledExactlyOnceWith('连接已断开'))
      expect(target.end).toHaveBeenCalledTimes(1)
      jumps.forEach((jump) => expect(jump.end).toHaveBeenCalledTimes(1))
      expect(target.end.mock.invocationCallOrder[0]).toBeLessThan(jumps[2]!.end.mock.invocationCallOrder[0]!)
      expect(jumps[2]!.end.mock.invocationCallOrder[0]).toBeLessThan(jumps[1]!.end.mock.invocationCallOrder[0]!)
      expect(jumps[1]!.end.mock.invocationCallOrder[0]).toBeLessThan(jumps[0]!.end.mock.invocationCallOrder[0]!)
      const next = await pool.acquire(hostId)
      expect(next.client).not.toBe(target.client)
      expect(sshConnect.connectEndpoint).toHaveBeenCalledTimes(2)
      leases.forEach((lease) => lease.release())
      next.release()
    }
  )

  it('l: a jump disconnect drops every lease and closes both clients exactly once', async () => {
    const target = new Connection()
    const jump = new Connection()
    vi.mocked(sshConnect.connectEndpoint).mockResolvedValueOnce({ client: target.client, jumps: [jump.client] })
    const leases = await Promise.all([pool.acquire(hostId), pool.acquire(hostId)])
    const drops = leases.map((lease) => { const drop = vi.fn(); lease.onDrop(drop); return drop })
    jump.emit('error', new Error('跳板断开'))
    jump.emit('close')
    target.emit('close')
    drops.forEach((drop) => expect(drop).toHaveBeenCalledTimes(1))
    expect(target.end).toHaveBeenCalledTimes(1)
    expect(jump.end).toHaveBeenCalledTimes(1)
    expect((await pool.acquire(hostId)).client).not.toBe(target.client)
  })

  it('closes active, retired, idle and late connections on shutdown', async () => {
    const old = await pool.acquire(hostId)
    await pool.acquire(hostId, { fresh: true })
    const gate = deferred<sshConnect.OpenedConnection>()
    vi.mocked(sshConnect.connectEndpoint).mockReturnValueOnce(gate.promise)
    const late = pool.acquire(hostId, { fresh: true })
    const rejected = expect(late).rejects.toThrow('连接池已关闭')
    await Promise.resolve()
    const closing = pool.closeAll()
    expect(pool.closeAll()).toBe(closing)
    const connection = new Connection()
    gate.resolve({ client: connection.client, jumps: [] })
    await closing
    await rejected
    expect(connection.end).toHaveBeenCalledTimes(1)
    connections.forEach((item) => expect(item.end).toHaveBeenCalledTimes(1))
    old.release()
    await expect(pool.acquire(hostId)).rejects.toThrow('连接池已关闭')
  })
})

describe('remote exec without sockets', () => {
  async function prepare() {
    const lease = await pool.acquire(hostId)
    lease.release()
    const channel = new Channel()
    connections[0]!.exec.mockImplementationOnce((_script, callback) => callback(undefined, channel.channel))
    return channel
  }

  it.each([undefined, '', '输入中文'])('g: sends stdin=%s and EOF, decodes split UTF-8 and retains exit code', async (stdin) => {
    const channel = await prepare()
    channel.end.mockImplementation(() => {
      const bytes = Buffer.from('你好')
      channel.emit('data', bytes.subarray(0, 2))
      channel.emit('data', bytes.subarray(2))
      channel.stderr.emit('data', Buffer.from('错误'))
      channel.emit('exit', 7)
      channel.emit('close')
    })
    await expect(pool.exec(hostId, '命令', { stdin })).resolves.toEqual({
      code: 7, signal: null, stdout: '你好', stderr: '错误', truncated: false, timedOut: false
    })
    expect(channel.end).toHaveBeenCalledWith(stdin ?? '')
  })

  it('g: retains signal termination', async () => {
    const channel = await prepare()
    channel.end.mockImplementation(() => { channel.emit('exit', null, 'TERM'); channel.emit('close') })
    expect(await pool.exec(hostId, '命令')).toMatchObject({ code: null, signal: 'TERM' })
  })

  it('h: caps combined stdout/stderr without closing the running command', async () => {
    const channel = await prepare()
    channel.end.mockImplementation(() => {
      channel.emit('data', Buffer.from('abc'))
      channel.stderr.emit('data', Buffer.from('defg'))
      channel.emit('data', Buffer.from('ignored'))
      expect(channel.close).not.toHaveBeenCalled()
      channel.emit('close', 0)
    })
    expect(await pool.exec(hostId, '命令', { maxOutputBytes: 5 })).toMatchObject({
      stdout: 'abc', stderr: 'de', truncated: true, timedOut: false
    })
  })

  it('h: times out, closes the channel and releases its lease', async () => {
    vi.useFakeTimers()
    const channel = await prepare()
    const pending = pool.exec(hostId, '等待', { timeoutMs: 20 })
    await vi.advanceTimersByTimeAsync(20)
    expect(await pending).toMatchObject({ timedOut: true, code: null })
    expect(channel.close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(connections[0]!.end).toHaveBeenCalledTimes(1)
  })

  it('uses a 30-second default timeout and allows explicitly disabling it', async () => {
    vi.useFakeTimers()
    const channel = await prepare()
    const timed = pool.exec(hostId, '等待')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(channel.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await timed).toMatchObject({ timedOut: true })
    const long = await prepare()
    const pending = pool.exec(hostId, '解压', { timeoutMs: 0 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(long.close).not.toHaveBeenCalled()
    long.emit('close', 0)
    expect(await pending).toMatchObject({ code: 0, timedOut: false })
  })

  it('h: aborts a running command, closes its channel, and leaves the connection reusable', async () => {
    const channel = await prepare()
    const controller = new AbortController()
    const pending = pool.exec(hostId, '等待', { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', message: '远程命令已中止' })
    await vi.waitFor(() => expect(channel.end).toHaveBeenCalled())
    controller.abort()
    await rejected
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect((await pool.acquire(hostId)).client).toBe(connections[0]!.client)
  })

  it('aborts before acquisition and during authentication without leaking a late lease', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    await expect(pool.exec(hostId, '命令', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(sshConnect.connectEndpoint).not.toHaveBeenCalled()
    const gate = deferred<sshConnect.OpenedConnection>()
    vi.mocked(sshConnect.connectEndpoint).mockReturnValueOnce(gate.promise)
    const waiting = new AbortController()
    const pending = pool.exec(hostId, '命令', { signal: waiting.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    waiting.abort()
    await rejected
    const connection = new Connection()
    gate.resolve({ client: connection.client, jumps: [] })
    await vi.advanceTimersByTimeAsync(100)
    expect(connection.end).toHaveBeenCalledTimes(1)
    expect(connection.exec).not.toHaveBeenCalled()
  })

  it('closes channels arriving after timeout and consumes their late errors', async () => {
    vi.useFakeTimers()
    await prepare()
    let accept!: (error: Error | undefined, channel?: ClientChannel) => void
    connections[0]!.exec.mockReset().mockImplementation((_script, callback) => { accept = callback })
    const pending = pool.exec(hostId, '等待', { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toMatchObject({ timedOut: true })
    const channel = new Channel()
    accept(undefined, channel.channel)
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(() => channel.emit('error', new Error('迟到'))).not.toThrow()
  })

  it('releases leases after exec setup errors and connection loss', async () => {
    vi.useFakeTimers()
    const channel = await prepare()
    connections[0]!.exec.mockReset().mockImplementationOnce((_script, callback) => callback(new Error('通道失败')))
    await expect(pool.exec(hostId, '命令')).rejects.toThrow('通道失败')
    connections[0]!.exec.mockImplementationOnce((_script, callback) => callback(undefined, channel.channel))
    const pending = pool.exec(hostId, '命令')
    const rejected = expect(pending).rejects.toThrow('连接已断开')
    await vi.advanceTimersByTimeAsync(0)
    connections[0]!.emit('close')
    await rejected
    expect(channel.close).toHaveBeenCalledTimes(1)
  })
})

describe('pooled sessions without sockets', () => {
  it('rejects file authentication completed after connection settings changed', async () => {
    const hub = makeHub()
    const gate = deferred<sshConnect.OpenedConnection>()
    const connection = new Connection()
    vi.mocked(sshConnect.connectEndpoint).mockReturnValueOnce(gate.promise)
    const opening = hub.openHostFiles(hostId)
    const rejected = expect(opening).rejects.toThrow('主机连接配置已更改')
    await vi.waitFor(() => expect(sshConnect.connectEndpoint).toHaveBeenCalledTimes(1))
    vault.saveHost({ ...vault.getHost(hostId)!, port: 2222 })
    hub.pool.invalidate(hostId)
    gate.resolve({ client: connection.client, jumps: [] })
    await rejected
    expect(connection.sftp).not.toHaveBeenCalled()
    expect(connection.shell).not.toHaveBeenCalled()
    expect(connection.end).toHaveBeenCalledTimes(1)
  })

  it('closes an SFTP channel delivered after its file context was deleted', async () => {
    const hub = makeHub()
    const connection = new Connection()
    vi.mocked(sshConnect.connectEndpoint).mockResolvedValueOnce({ client: connection.client, jumps: [] })
    let deliver!: (error: undefined, sftp: SFTPWrapper) => void
    connection.sftp.mockImplementationOnce((callback) => { deliver = callback })
    const opening = hub.openHostFiles(hostId)
    const rejected = expect(opening).rejects.toThrow('会话连接已失效')
    await vi.waitFor(() => expect(connection.sftp).toHaveBeenCalledTimes(1))
    await hub.closeHost(hostId)
    const channel = { end: vi.fn() }
    deliver(undefined, channel as unknown as SFTPWrapper)
    await rejected
    expect(channel.end).toHaveBeenCalledTimes(1)
    expect(hub['sessions'].size).toBe(0)
  })

  it('i: broadcasts connection loss and reconnects only one tab with the actual dimensions', async () => {
    const hub = makeHub()
    const [first, second] = await Promise.all([hub.connect(hostId, 80, 24), hub.connect(hostId, 90, 30)])
    expect(connections).toHaveLength(1)
    connections[0]!.shells.forEach((shell) => expect(shell.write).toHaveBeenCalledWith('echo 初始化\n'))
    await Promise.all([hub['sftpOf'](first.id), hub['sftpOf'](second.id)])
    expect(connections[0]!.sftps).toHaveLength(2)
    connections[0]!.emit('error', new Error('断线'))
    expect(hub.list().map((session) => [session.status, session.message])).toEqual([
      ['closed', '连接已断开'], ['closed', '连接已断开']
    ])
    await hub.reconnect(first.id, 137, 43)
    expect(hub.list().map((session) => session.status)).toEqual(['connected', 'closed'])
    expect(connections[1]!.shell).toHaveBeenCalledWith(expect.objectContaining({ cols: 137, rows: 43 }), expect.any(Function))
    connections[0]!.emit('close')
    connections[0]!.emit('error', new Error('迟到'))
    expect(hub.list()[0]!.status).toBe('connected')
  })

  it('a shell exit, tab close and healthy reconnect leave other tabs on the old connection', async () => {
    const hub = makeHub()
    const first = await hub.connect(hostId, 80, 24)
    const second = await hub.connect(hostId, 80, 24)
    connections[0]!.shells[0]!.emit('close')
    expect(hub.list().map((session) => session.status)).toEqual(['closed', 'connected'])
    await hub.reconnect(first.id, 100, 30)
    expect(connections[0]!.end).not.toHaveBeenCalled()
    expect(hub.list().map((session) => session.status)).toEqual(['connected', 'connected'])
    await hub.close(first.id)
    expect(connections[0]!.end).not.toHaveBeenCalled()
    await hub.close(second.id)
    expect(connections[0]!.end).toHaveBeenCalledTimes(1)
  })

  it('j: closing during acquire releases only that tab’s lease', async () => {
    const hub = makeHub()
    const gate = deferred<sshConnect.OpenedConnection>()
    const connection = new Connection()
    vi.mocked(sshConnect.connectEndpoint).mockReturnValueOnce(gate.promise)
    const first = hub.connect(hostId, 80, 24)
    const rejected = expect(first).rejects.toThrow('会话已关闭')
    const firstId = hub.list()[0]!.id
    const second = hub.connect(hostId, 80, 24)
    await hub.close(firstId)
    gate.resolve({ client: connection.client, jumps: [] })
    await rejected
    expect(await second).toMatchObject({ status: 'connected' })
    expect(connection.shell).toHaveBeenCalledTimes(1)
    expect(connection.end).not.toHaveBeenCalled()
    expect(hub.list()).toHaveLength(1)
  })

  it('releases only the failed shell lease and keeps another tab connected', async () => {
    const hub = makeHub()
    await hub.connect(hostId, 80, 24)
    vi.spyOn(sshConnect, 'openShell').mockRejectedValueOnce(new Error('shell 失败'))
    await expect(hub.connect(hostId, 80, 24)).rejects.toThrow('shell 失败')
    expect(hub.list()).toHaveLength(1)
    expect(hub.list()[0]!.status).toBe('connected')
    expect(connections[0]!.end).not.toHaveBeenCalled()
  })

  it('closing while a shell opens consumes and closes the late channel without affecting another tab', async () => {
    const hub = makeHub()
    await hub.connect(hostId, 80, 24)
    const channel = new Channel()
    const gate = deferred<ClientChannel>()
    vi.spyOn(sshConnect, 'openShell').mockReturnValueOnce(gate.promise)
    const second = hub.connect(hostId, 80, 24)
    const rejected = expect(second).rejects.toThrow('会话连接已失效')
    await vi.waitFor(() => expect(sshConnect.openShell).toHaveBeenCalledTimes(1))
    await hub.close(hub.list()[1]!.id)
    gate.resolve(channel.channel)
    await rejected
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(connections[0]!.end).not.toHaveBeenCalled()
    expect(hub.list()[0]!.status).toBe('connected')
  })

  it('a superseded reconnect failure cannot overwrite a newer connected session', async () => {
    const hub = makeHub()
    const first = await hub.connect(hostId, 80, 24)
    const gate = deferred<sshConnect.OpenedConnection>()
    vi.mocked(sshConnect.connectEndpoint).mockReturnValueOnce(gate.promise)
    const stale = hub.reconnect(first.id, 90, 30)
    const rejected = expect(stale).rejects.toThrow('旧重连失败')
    await Promise.resolve()
    await hub.reconnect(first.id, 120, 40)
    gate.reject(new Error('旧重连失败'))
    await rejected
    expect(hub.list()[0]!.status).toBe('connected')
    expect(connections.at(-1)!.shell).toHaveBeenLastCalledWith(expect.objectContaining({ cols: 120, rows: 40 }), expect.any(Function))
  })

  it('extracts an upload on the tab’s SFTP connection without a timeout, even after pool invalidation', async () => {
    const hub = makeHub()
    const first = await hub.connect(hostId, 80, 24)
    const session = hub['sessions'].get(first.id)!
    const original = session.lease!.client
    hub.pool.invalidate(hostId)
    const other = await hub.pool.acquire(hostId)
    expect(other.client).not.toBe(original)
    const upload = vi.spyOn(sftpOps, 'uploadFile').mockResolvedValue(undefined)
    const execute = vi.spyOn(sshExec, 'execOnClient').mockResolvedValue({
      code: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false
    })
    const poolExec = vi.spyOn(hub.pool, 'exec')
    const local = path.join(workspace, 'packed')
    fs.mkdirSync(local)
    fs.writeFileSync(path.join(local, 'small.txt'), '内容')
    const hooks = { signal: new AbortController().signal, onProgress: vi.fn() }
    await hub['packUpload'](session, local, '/', hooks, new sftpOps.TransferCleanup())
    expect(upload).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(original, expect.stringContaining('tar -xzf'), { timeoutMs: 0, signal: hooks.signal })
    expect(poolExec).not.toHaveBeenCalled()
    other.release()
  })

  it('k: failed preservation retains the lease and a retried close releases exactly once', async () => {
    const hub = makeHub()
    const first = await hub.connect(hostId, 80, 24)
    const session = hub['sessions'].get(first.id)!
    const release = vi.spyOn(session.lease!, 'release')
    const directory = path.join(workspace, 'watch', first.id)
    fs.mkdirSync(directory, { recursive: true })
    const localPath = path.join(directory, 'readme.txt')
    fs.writeFileSync(localPath, '未回传的内容')
    session.watchers.set('/readme.txt', {
      chain: Promise.resolve(), controller: new AbortController(), stopped: false,
      localPath, manifestPath: path.join(directory, '.hopline-edit.json'), dirty: true, revision: 1
    })
    const obstruction = path.join(workspace, 'recovered')
    fs.writeFileSync(obstruction, '不是目录')
    await expect(hub.close(first.id)).rejects.toThrow()
    expect(hub.list()[0]).toMatchObject({ status: 'error', message: '未回传修改保全失败，本地副本已保留' })
    expect(release).not.toHaveBeenCalled()
    expect(connections[0]!.end).not.toHaveBeenCalled()
    fs.unlinkSync(obstruction)
    await hub.close(first.id)
    await hub.close(first.id)
    expect(release).toHaveBeenCalledTimes(1)
    const files = fs.readdirSync(obstruction)
    expect(fs.readFileSync(path.join(obstruction, files[0]!), 'utf8')).toBe('未回传的内容')
  })
})

it('background acquisition never joins a foreground handshake awaiting a prompt', async () => {
  const gate = deferred<sshConnect.OpenedConnection>()
  vi.mocked(sshConnect.connectEndpoint).mockImplementationOnce(() => gate.promise)
  const manual = pool.acquire(hostId)
  await Promise.resolve()
  await expect(pool.acquire(hostId, { interaction: 'forbid' })).rejects.toMatchObject({ reason: 'authentication' })
  expect(sshConnect.connectEndpoint).toHaveBeenCalledOnce()
  const connection = new Connection()
  gate.resolve({ client: connection.client, jumps: [] })
  const lease = await manual
  expect(connection.end).not.toHaveBeenCalled()
  const reused = await pool.acquire(hostId, { interaction: 'forbid' })
  expect(reused.client).toBe(lease.client)
  lease.release(); reused.release()
})

it('foreground acquisition regains its prompt callbacks after a background authentication refusal', async () => {
  const gate = deferred<sshConnect.OpenedConnection>()
  vi.mocked(sshConnect.connectEndpoint).mockImplementationOnce(() => gate.promise)
  const background = pool.acquire(hostId, { interaction: 'forbid' })
  const rejected = expect(background).rejects.toMatchObject({ reason: 'host-key' })
  await Promise.resolve()
  const manual = pool.acquire(hostId)
  expect(sshConnect.connectEndpoint).toHaveBeenCalledOnce()
  gate.reject(new sshConnect.SshConnectionError('host-key', '主机指纹需要确认'))
  await rejected
  const lease = await manual
  expect(sshConnect.connectEndpoint).toHaveBeenCalledTimes(2)
  expect(vi.mocked(sshConnect.connectEndpoint).mock.calls[1][1]).toMatchObject({ verifyHost, onKeyboard: keyboard })
  lease.release()
})

it('non-interactive password connections without stored credentials fail before opening SSH', async () => {
  vault.saveHost({ ...vault.getHost(hostId)!, password: null })
  await expect(pool.acquire(hostId, { interaction: 'forbid' })).rejects.toMatchObject({ reason: 'authentication' })
  expect(sshConnect.connectEndpoint).not.toHaveBeenCalled()
  expect(verifyHost).not.toHaveBeenCalled()
  expect(keyboard).not.toHaveBeenCalled()
})
