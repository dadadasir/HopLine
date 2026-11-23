import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'
import { execOnClient } from '../src/main/ssh/exec'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { SessionHub } from '../src/main/sessions'
import { startMiniSshd } from './support/mini-sshd.mjs'

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

// Real loopback integration tests; run outside the sandbox that forbids local listeners.
describe('connection pool with mini-sshd', () => {
  let workspace: string
  let server: Awaited<ReturnType<typeof startMiniSshd>>
  let jump: Awaited<ReturnType<typeof startMiniSshd>> | undefined
  let vault: Vault
  let pool: ConnectionPool
  let hub: SessionHub | undefined
  let hostId: string
  const verifyHost = vi.fn(async () => true)

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-pool-live-'))
    server = await startMiniSshd({ password: 'test', root: path.join(workspace, 'server'), atomicEditFixture: true })
    vault = new Vault(emptyStore(), new MemorySecretCodec())
    hostId = vault.saveHost({ groupId: null, name: '测试主机', host: '127.0.0.1', port: server.port,
      username: 'hop', authType: 'password', password: 'test' }).id
    verifyHost.mockClear()
    pool = new ConnectionPool(vault, { idleMs: 100, verifyHost, onKeyboard: async () => null })
  })

  afterEach(async () => {
    await hub?.closeAll()
    await hub?.pool.closeAll()
    await pool?.closeAll()
    await jump?.close()
    await server?.close()
    hub = undefined
    jump = undefined
    vi.restoreAllMocks()
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('background host-key checks never prompt, while foreground trust can still be saved and reused', async () => {
    const known = new KnownHostFile(path.join(workspace, 'background-known.json')), emit = vi.fn()
    hub = new SessionHub(vault, known, emit, workspace)
    await expect(hub.pool.acquire(hostId, { interaction: 'forbid' })).rejects.toMatchObject({ reason: 'host-key' })
    expect(emit).not.toHaveBeenCalled()
    expect(known.entries).toEqual([])
    const manual = hub.pool.acquire(hostId)
    await vi.waitFor(() => expect(emit.mock.calls.some(([channel]) => channel === 'hostkey:prompt')).toBe(true))
    const request = emit.mock.calls.find(([channel]) => channel === 'hostkey:prompt')![1]
    hub.respondHostKey(request.requestId, 'save')
    ;(await manual).release()
    expect(known.entries).toHaveLength(1)
    hub.pool.invalidate(hostId); emit.mockClear()
    const background = await hub.pool.acquire(hostId, { interaction: 'forbid' })
    expect(await execOnClient(background.client, 'printf trusted')).toMatchObject({ code: 0, stdout: 'trusted' })
    expect(emit).not.toHaveBeenCalled()
    background.release(); hub.pool.invalidate(hostId)
    known.entries[0].fingerprint = 'changed-fingerprint'
    await expect(hub.pool.acquire(hostId, { interaction: 'forbid' })).rejects.toMatchObject({ reason: 'host-key' })
    expect(emit).not.toHaveBeenCalled()
    expect(known.entries[0].fingerprint).toBe('changed-fingerprint')
  })

  it('background keyboard challenges need attention without calling the foreground prompt', async () => {
    await pool.closeAll(); await server.close()
    server = await startMiniSshd({ root: path.join(workspace, 'keyboard'), authenticate(ctx) {
      if (ctx.method === 'keyboard-interactive') ctx.prompt([{ prompt: 'OTP', echo: false }, { prompt: 'Second answer', echo: false }], answers => {
        if (answers[0] === 'one' && answers[1] === 'two') ctx.accept(); else ctx.reject()
      })
      else ctx.reject(['keyboard-interactive'])
    } })
    vault.saveHost({ ...vault.getHost(hostId)!, port: server.port, authType: 'keyboard-interactive', password: null })
    const keyboard = vi.fn(async () => ['one', 'two'])
    pool = new ConnectionPool(vault, { verifyHost, verifyHostWithoutPrompt: async () => true, onKeyboard: keyboard })
    await expect(pool.acquire(hostId, { interaction: 'forbid' })).rejects.toMatchObject({ reason: 'authentication' })
    expect(keyboard).not.toHaveBeenCalled(); expect(verifyHost).not.toHaveBeenCalled()
    const manual = await pool.acquire(hostId)
    expect(keyboard).toHaveBeenCalledOnce(); expect(verifyHost).toHaveBeenCalledOnce()
    expect(await execOnClient(manual.client, 'printf ready')).toMatchObject({ code: 0, stdout: 'ready' })
    manual.release()
  })

  it('a: three sequential leases share one TCP connection', async () => {
    const leases = [await pool.acquire(hostId), await pool.acquire(hostId), await pool.acquire(hostId)]
    expect(server.acceptedConnections).toBe(1)
    expect(new Set(leases.map((lease) => lease.client)).size).toBe(1)
    leases.forEach((lease) => lease.release())
  })

  it('b: concurrent acquisitions await one host-key confirmation and one TCP connection', async () => {
    let confirm!: (accepted: boolean) => void
    verifyHost.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
    const pending = [pool.acquire(hostId), pool.acquire(hostId), pool.acquire(hostId)]
    await vi.waitFor(() => expect(verifyHost).toHaveBeenCalledTimes(1))
    expect(server.acceptedConnections).toBe(1)
    confirm(true)
    const leases = await Promise.all(pending)
    expect(server.acceptedConnections).toBe(1)
    leases.forEach((lease) => lease.release())
  })

  it('c: reuse cancels idle eviction; the last release eventually closes the TCP connection', async () => {
    const first = await pool.acquire(hostId)
    first.release()
    const reused = await pool.acquire(hostId)
    expect(reused.client).toBe(first.client)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(server.activeConnections).toBe(1)
    reused.release()
    await vi.waitFor(() => expect(server.activeConnections).toBe(0))
    expect((await pool.acquire(hostId)).client).not.toBe(first.client)
    expect(server.acceptedConnections).toBe(2)
  })

  it('d: failed authentication rejects all waiters with the same error and permits retry', async () => {
    vault.saveHost({ ...vault.getHost(hostId)!, password: 'wrong' })
    const results = await Promise.allSettled([pool.acquire(hostId), pool.acquire(hostId), pool.acquire(hostId)])
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    if (results[0]!.status !== 'rejected') throw new Error('预期认证失败')
    const error = results[0]!.reason
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toBe(error)
    expect(server.acceptedConnections).toBe(1)
    vault.saveHost({ ...vault.getHost(hostId)!, password: 'test' })
    await pool.acquire(hostId)
    expect(server.acceptedConnections).toBe(2)
  })

  it('e: server disconnect notifies each lease exactly once and next acquire reconnects', async () => {
    const leases = await Promise.all([pool.acquire(hostId), pool.acquire(hostId), pool.acquire(hostId)])
    const drops = leases.map((lease) => { const drop = vi.fn(); lease.onDrop(drop); return drop })
    server.disconnectAll()
    await vi.waitFor(() => drops.forEach((drop) => expect(drop).toHaveBeenCalledExactlyOnceWith('连接已断开')))
    const next = await pool.acquire(hostId)
    expect(next.client).not.toBe(leases[0]!.client)
    expect(server.acceptedConnections).toBe(2)
    drops.forEach((drop) => expect(drop).toHaveBeenCalledTimes(1))
  })

  it.each(['invalidate', 'fresh'] as const)('f: %s leaves the old lease usable until released', async (action) => {
    const old = await pool.acquire(hostId)
    if (action === 'invalidate') pool.invalidate(hostId)
    const next = await pool.acquire(hostId, { fresh: action === 'fresh' })
    expect(next.client).not.toBe(old.client)
    expect(server.acceptedConnections).toBe(2)
    expect(await execOnClient(old.client, 'printf old')).toMatchObject({ code: 0, stdout: 'old' })
    old.release()
    await vi.waitFor(() => expect(server.activeConnections).toBe(1))
    expect(await pool.exec(hostId, 'printf new')).toMatchObject({ code: 0, stdout: 'new' })
  })

  it('g: executes stdout, stderr, exit status, UTF-8 stdin and empty stdin EOF', async () => {
    expect(await pool.exec(hostId, 'cat; printf 错误 >&2; exit 7', { stdin: '你好\n' })).toEqual({
      code: 7, signal: null, stdout: '你好\n', stderr: '错误', timedOut: false, truncated: false
    })
    expect(await pool.exec(hostId, 'cat')).toMatchObject({ code: 0, stdout: '', stderr: '' })
  })

  it('validates after authentication and releases the lease without sending a rejected command', async () => {
    let confirm!: (accepted: boolean) => void
    verifyHost.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve }))
    const beforeStart = vi.fn(() => { throw new Error('Target changed before dispatch') })
    const marker = path.join(workspace, 'must-not-run')
    const pending = pool.exec(hostId, `printf sent > '${marker}'`, { beforeStart })
    const rejected = expect(pending).rejects.toThrow('Target changed before dispatch')
    await vi.waitFor(() => expect(verifyHost).toHaveBeenCalledTimes(1))
    expect(beforeStart).not.toHaveBeenCalled()
    confirm(true)
    await rejected
    expect(beforeStart).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(marker)).toBe(false)
    await vi.waitFor(() => expect(server.activeConnections).toBe(0))
  })

  it('h: closes timed-out and aborted channels and bounds combined output', async () => {
    const timed = pool.exec(hostId, 'exec sleep 20', { timeoutMs: 500 })
    await vi.waitFor(() => expect(server.activeExecs).toBe(1))
    expect(await timed).toMatchObject({ timedOut: true })
    await vi.waitFor(() => expect(server.activeExecs).toBe(0))
    const limited = await pool.exec(hostId, 'printf 123456; printf 7890 >&2', { maxOutputBytes: 4 })
    expect(limited).toMatchObject({ code: 0, truncated: true })
    expect(Buffer.byteLength(limited.stdout + limited.stderr)).toBe(4)
    const controller = new AbortController()
    const aborted = pool.exec(hostId, 'exec sleep 20', { signal: controller.signal })
    const assertion = expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(server.activeExecs).toBe(1))
    controller.abort()
    await assertion
    await vi.waitFor(() => expect(server.activeExecs).toBe(0))
  })

  it('i: disconnects both tabs, then reconnects one with caller-supplied terminal size', async () => {
    const known = new KnownHostFile(path.join(workspace, 'known.json'))
    vi.spyOn(known, 'judge').mockReturnValue('trusted')
    hub = new SessionHub(vault, known, vi.fn(), workspace)
    const [first] = await Promise.all([hub.connect(hostId, 80, 24), hub.connect(hostId, 90, 30)])
    expect(server.acceptedConnections).toBe(1)
    server.disconnectAll()
    await vi.waitFor(() => expect(hub!.list().map((item) => item.status)).toEqual(['closed', 'closed']))
    await hub.reconnect(first!.id, 133, 47)
    expect(hub.list().map((item) => item.status)).toEqual(['connected', 'closed'])
    expect(server.shellSizes.at(-1)).toEqual({ cols: 133, rows: 47 })
  })

  it('l: dropping the real jump connection notifies all target leases once', async () => {
    jump = await startMiniSshd({ password: 'jump-secret', root: path.join(workspace, 'jump') })
    vault.saveHost({ ...vault.getHost(hostId)!, jumps: [{
      host: '127.0.0.1', port: jump.port, username: 'hop', authType: 'password',
      privateKeyPath: null, password: 'jump-secret'
    }] })
    const leases = await Promise.all([pool.acquire(hostId), pool.acquire(hostId)])
    const drops = leases.map((lease) => { const drop = vi.fn(); lease.onDrop(drop); return drop })
    expect(jump.acceptedConnections).toBe(1)
    expect(await execOnClient(leases[0]!.client, 'printf target')).toMatchObject({ stdout: 'target' })
    jump.disconnectAll()
    await vi.waitFor(() => drops.forEach((drop) => expect(drop).toHaveBeenCalledTimes(1)))
    expect((await pool.acquire(hostId)).client).not.toBe(leases[0]!.client)
    expect(jump.acceptedConnections).toBe(2)
  })

  it('j: closing one tab during host confirmation does not cancel the other or leak a lease', async () => {
    const known = new KnownHostFile(path.join(workspace, 'known.json'))
    const emit = vi.fn()
    hub = new SessionHub(vault, known, emit, workspace)
    const first = hub.connect(hostId, 80, 24)
    const rejected = expect(first).rejects.toThrow('会话已关闭')
    const firstId = hub.list()[0]!.id
    const second = hub.connect(hostId, 80, 24)
    await vi.waitFor(() => expect(emit.mock.calls.some(([channel]) => channel === 'hostkey:prompt')).toBe(true))
    await hub.close(firstId)
    const request = emit.mock.calls.find(([channel]) => channel === 'hostkey:prompt')![1]
    hub.respondHostKey(request.requestId, 'once')
    await rejected
    const connected = await second
    expect(connected.status).toBe('connected')
    expect(server.acceptedConnections).toBe(1)
    hub.pool.invalidate(hostId)
    await hub.close(connected.id)
    await vi.waitFor(() => expect(server.activeConnections).toBe(0))
  })

  it('k: preservation failure keeps the lease until a successful close retry', async () => {
    const known = new KnownHostFile(path.join(workspace, 'known.json'))
    vi.spyOn(known, 'judge').mockReturnValue('trusted')
    hub = new SessionHub(vault, known, vi.fn(), workspace)
    const connected = await hub.connect(hostId, 80, 24)
    const session = hub['sessions'].get(connected.id)!
    const release = vi.spyOn(session.lease!, 'release')
    const { localPath } = await hub.editRemote(connected.id, '/readme.txt')
    fs.writeFileSync(localPath, '尚未回传')
    const obstruction = path.join(workspace, 'recovered')
    fs.writeFileSync(obstruction, '不是目录')
    hub.pool.invalidate(hostId)
    await expect(hub.close(connected.id)).rejects.toThrow()
    expect(release).not.toHaveBeenCalled()
    expect(server.activeConnections).toBe(1)
    fs.unlinkSync(obstruction)
    await hub.close(connected.id)
    await hub.close(connected.id)
    expect(release).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(server.activeConnections).toBe(0))
  })
})
