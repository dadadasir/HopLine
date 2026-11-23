import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Vault, emptyStore, MemorySecretCodec } from '../src/core/vault'
import { ForwardManager } from '../src/main/forwarding'
import { ConnectionPool } from '../src/main/ssh/pool'
import { SessionHub } from '../src/main/sessions'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { startMiniSshd } from './support/mini-sshd.mjs'
import type { ForwardRule } from '../src/shared/types'

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../src/main/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
let dir: string, vault: Vault, pool: ConnectionPool, manager: ForwardManager, hostId: string
let sshd: Awaited<ReturnType<typeof startMiniSshd>>, hub: SessionHub | undefined
let echo: net.Server, echoPort: number
const sockets = new Set<net.Socket>(), listeners = new Set<net.Server>(), emit = vi.fn()
async function listen(server: net.Server, host = '127.0.0.1', port = 0) {
  listeners.add(server)
  server.listen(port, host)
  await once(server, 'listening')
  return (server.address() as net.AddressInfo).port
}
async function freePort() {
  const server = net.createServer(), port = await listen(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
async function socketAt(port: number) {
  const socket = net.connect(port, '127.0.0.1'); sockets.add(socket)
  socket.on('error', () => {})
  await once(socket, 'connect')
  return socket
}
async function read(socket: net.Socket, length: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error('read timed out')) }, 3000)
    const data = (chunk: Buffer) => { chunks.push(chunk); total += chunk.length; if (total >= length) { done(); resolve(Buffer.concat(chunks)) } }
    const done = () => { clearTimeout(timer); socket.off('data', data) }
    socket.on('data', data)
  })
}
async function roundtrip(port: number) {
  const socket = await socketAt(port), result = read(socket, 12)
  socket.write('hello 世界')
  expect((await result).toString()).toBe('hello 世界')
  socket.destroy()
}
async function add(type: ForwardRule['type'], extra: Partial<ForwardRule> = {}) {
  const rule: ForwardRule = { id: crypto.randomUUID(), type, bindHost: '127.0.0.1', bindPort: await freePort(),
    targetHost: type === 'dynamic' ? null : '127.0.0.1', targetPort: type === 'dynamic' ? null : echoPort, autoStart: false, ...extra }
  vault.saveHost({ ...vault.listHosts()[0]!, forwards: [...vault.listHosts()[0]!.forwards, rule] })
  return rule
}
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-forward-'))
  sshd = await startMiniSshd({ password: 'test', tcpipForward: true, root: path.join(dir, 'sshd') })
  echo = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); socket.pipe(socket) })
  echoPort = await listen(echo)
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  hostId = vault.saveHost({ groupId: null, name: 'forward test', host: '127.0.0.1', port: sshd.port, username: 'hop', authType: 'password', password: 'test' }).id
  pool = new ConnectionPool(vault, { idleMs: 30, verifyHost: async () => true, onKeyboard: async () => null })
  manager = new ForwardManager(pool, vault, emit)
  emit.mockClear()
})
afterEach(async () => {
  await manager?.stopAll(); await hub?.closeAll(); await hub?.pool.closeAll(); await pool?.closeAll()
  for (const socket of sockets) socket.destroy()
  for (const server of listeners) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  await sshd?.close()
  sockets.clear(); listeners.clear(); hub = undefined; vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

it.each(['local', 'remote'] as const)('%s transfers real bytes, tracks connections, stops active streams and releases the port', async (type) => {
  const rule = await add(type)
  await Promise.all([manager.start(hostId, rule.id), manager.start(hostId, rule.id)])
  expect(sshd.acceptedConnections).toBe(1)
  await roundtrip(rule.bindPort)
  const socket = await socketAt(rule.bindPort)
  await vi.waitFor(() => expect(manager.statuses()[0]).toMatchObject({ state: 'running', connections: 1 }))
  await manager.stop(hostId, rule.id)
  await vi.waitFor(() => expect(socket.destroyed).toBe(true))
  expect(manager.statuses()[0]).toMatchObject({ state: 'stopped', connections: 0 })
  expect(emit.mock.calls.some(([channel, states]) => channel === 'forwards:status' && states[0].state === 'running')).toBe(true)
  await vi.waitFor(async () => { await listen(net.createServer(), '127.0.0.1', rule.bindPort) })
  await vi.waitFor(() => expect(sshd.activeConnections).toBe(0))
})

// Remote forwarding is not covered here: ssh2's server-side Channel closes the whole channel on EOF, so mini-sshd
// cannot model half-close. OpenSSH can; the client-side channel HopLine accepts already allows half-open.
it.each(['local'] as const)('%s keeps the reply path open after the client half-closes', async (type) => {
  // A server that answers only once it has seen EOF: without half-open support the reply is lost.
  const replyOnEnd = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket); let got = ''
    socket.on('data', (chunk) => { got += chunk }).on('end', () => socket.end(`got:${got}`))
  })
  const rule = await add(type, { targetPort: await listen(replyOnEnd) })
  await manager.start(hostId, rule.id)
  const socket = net.connect({ port: rule.bindPort, host: '127.0.0.1', allowHalfOpen: true }); sockets.add(socket)
  await once(socket, 'connect')
  const reply = read(socket, 8)
  socket.end('ping')
  expect((await reply).toString()).toBe('got:ping')
})

it.each(['ipv4', 'domain', 'ipv6'] as const)('SOCKS5 CONNECT supports %s, fragmented headers and pipelined payload', async (type) => {
  let target = echoPort
  if (type === 'ipv6') target = await listen(net.createServer((socket) => { sockets.add(socket); socket.pipe(socket) }), '::1')
  const rule = await add('dynamic'); await manager.start(hostId, rule.id)
  const socket = await socketAt(rule.bindPort), greeting = read(socket, 2)
  socket.write(Buffer.from([5])); socket.write(Buffer.from([1, 0]))
  expect(await greeting).toEqual(Buffer.from([5, 0]))
  const address = type === 'ipv4' ? Buffer.from([1, 127, 0, 0, 1]) : type === 'ipv6'
    ? Buffer.from([4, ...Array(15).fill(0), 1]) : Buffer.concat([Buffer.from([3, 9]), Buffer.from('localhost')])
  const port = Buffer.alloc(2); port.writeUInt16BE(target)
  const reply = read(socket, 14)
  socket.write(Buffer.from([5, 1])); socket.write(Buffer.concat([Buffer.from([0]), address, port, Buffer.from('ping')]))
  expect(await reply).toEqual(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0, 112, 105, 110, 103]))
})

it.each([2, 3])('SOCKS5 rejects command %s', async (command) => {
  const rule = await add('dynamic'); await manager.start(hostId, rule.id)
  const socket = await socketAt(rule.bindPort), reply = read(socket, 12)
  socket.write(Buffer.from([5, 1, 0, 5, command, 0, 1]))
  expect((await reply).subarray(0, 4)).toEqual(Buffer.from([5, 0, 5, 7]))
  expect(manager.statuses()[0]!.state).toBe('running')
})

it('survives terminal closure, then normal pool idle eviction resumes after stop', async () => {
  const known = new KnownHostFile(path.join(dir, 'known.json')); vi.spyOn(known, 'judge').mockReturnValue('trusted')
  hub = new SessionHub(vault, known, vi.fn(), dir)
  hub.pool['options'].idleMs = 30
  manager = new ForwardManager(hub.pool, vault, emit)
  const rule = await add('local'), session = await hub.connect(hostId, 80, 24)
  await manager.start(hostId, rule.id); await hub.close(session.id)
  expect([...hub.pool['entries']][0]!.refs).toBe(1)
  await roundtrip(rule.bindPort)
  expect(sshd.acceptedConnections).toBe(1)
  await manager.stop(hostId, rule.id)
  await vi.waitFor(() => expect(sshd.activeConnections).toBe(0))
})

it('auto-start runs after session connection, skips duplicates and records failures without interrupting SSH', async () => {
  const known = new KnownHostFile(path.join(dir, 'known.json')); vi.spyOn(known, 'judge').mockReturnValue('trusted')
  hub = new SessionHub(vault, known, vi.fn(), dir)
  manager = new ForwardManager(hub.pool, vault, emit); hub.autoStartForwards = (id) => manager.autoStart(id)
  const occupied = await add('local', { bindPort: echoPort, autoStart: true })
  const rule = await add('dynamic', { autoStart: true }); await add('local')
  expect((await hub.connect(hostId, 80, 24)).status).toBe('connected')
  await vi.waitFor(() => expect(manager.statuses().map((item) => item.state)).toEqual(['error', 'running', 'stopped']))
  expect(manager.statuses()[0]!.error).toBe(`本地端口 ${occupied.bindPort} 已被占用`)
  await manager.autoStart(hostId)
  expect(manager.statuses()[1]!.state).toBe('running'); expect(sshd.acceptedConnections).toBe(1)
  expect(emit.mock.calls.every(([channel]) => channel === 'forwards:status')).toBe(true)
  await manager.stop(hostId, rule.id)
})

it('disconnect marks all rules error, frees listeners, does not reconnect, and supports manual restart', async () => {
  const rules = [await add('local'), await add('dynamic'), await add('remote')]
  for (const rule of rules) await manager.start(hostId, rule.id)
  sshd.disconnectAll()
  await vi.waitFor(() => expect(manager.statuses().every((item) => item.state === 'error' && item.error === '连接已断开')).toBe(true))
  for (const rule of rules) {
    const listener = net.createServer(); await listen(listener, '127.0.0.1', rule.bindPort)
    await new Promise<void>((resolve) => listener.close(() => resolve()))
  }
  expect(sshd.acceptedConnections).toBe(1)
  await manager.start(hostId, rules[0]!.id); await roundtrip(rules[0]!.bindPort)
  expect(sshd.acceptedConnections).toBe(2)
})

it('reconcile retains unchanged rules and stops changed or deleted rules', async () => {
  const a = await add('local'), b = await add('dynamic')
  await manager.start(hostId, a.id); await manager.start(hostId, b.id)
  vault.saveHost({ ...vault.listHosts()[0]!, name: 'renamed' }); await manager.reconcile()
  expect(manager.statuses().map((item) => item.state)).toEqual(['running', 'running'])
  vault.saveHost({ ...vault.listHosts()[0]!, forwards: [{ ...a, targetPort: 1 }] }); await manager.reconcile()
  expect(manager.statuses()).toEqual([{ hostId, ruleId: a.id, state: 'stopped', error: undefined, connections: 0 }])
  await listen(net.createServer(), '127.0.0.1', a.bindPort); await listen(net.createServer(), '127.0.0.1', b.bindPort)
})

it('stop while acquiring a lease releases the late lease without opening a port', async () => {
  const rule = await add('local'), actual = await pool.acquire(hostId)
  let resolve!: (lease: typeof actual) => void
  manager = new ForwardManager({ acquire: () => new Promise((ready) => { resolve = ready }) }, vault, emit)
  const started = manager.start(hostId, rule.id), stopped = manager.stop(hostId, rule.id)
  const release = vi.spyOn(actual, 'release'); resolve(actual)
  await Promise.all([started, stopped])
  expect(release).toHaveBeenCalledTimes(1); expect(manager.statuses()[0]!.state).toBe('stopped')
  await listen(net.createServer(), '127.0.0.1', rule.bindPort)
})

it('stop during remote bind cleans up a late successful bind', async () => {
  const rule = await add('remote'), lease = await pool.acquire(hostId)
  const original = lease.client.forwardIn.bind(lease.client)
  let complete: (() => void) | undefined
  vi.spyOn(lease.client, 'forwardIn').mockImplementation((address, port, callback) => original(address, port, (error, bound) => {
    complete = () => callback!(error, bound)
  }))
  const starting = manager.start(hostId, rule.id)
  await vi.waitFor(() => expect(complete).toBeDefined())
  const stopping = manager.stop(hostId, rule.id); complete!()
  await Promise.all([starting, stopping]); lease.release()
  await vi.waitFor(() => expect(sshd.activeConnections).toBe(0))
  await listen(net.createServer(), '127.0.0.1', rule.bindPort)
  expect(manager.statuses()[0]!.state).toBe('stopped')
})

it('SOCKS rejects authentication methods without no-auth, and reports CONNECT failures', async () => {
  const rule = await add('dynamic'); await manager.start(hostId, rule.id)
  const unsupported = await socketAt(rule.bindPort), authReply = read(unsupported, 2)
  unsupported.write(Buffer.from([5, 1, 2]))
  expect(await authReply).toEqual(Buffer.from([5, 255]))
  const socket = await socketAt(rule.bindPort), reply = read(socket, 12), port = await freePort()
  socket.write(Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]))
  expect((await reply).subarray(0, 4)).toEqual(Buffer.from([5, 0, 5, 5]))
  await manager.stopAll()
  expect(manager.statuses()[0]).toMatchObject({ state: 'stopped', connections: 0 })
  await expect(manager.start(hostId, rule.id)).rejects.toThrow('转发管理器已关闭')
})

it('does not reconnect if the connection drops during sequential auto-start', async () => {
  await add('remote', { autoStart: true }); await add('local', { autoStart: true })
  const lease = await pool.acquire(hostId), original = lease.client.forwardIn.bind(lease.client)
  let complete: (() => void) | undefined
  vi.spyOn(lease.client, 'forwardIn').mockImplementation((address, port, callback) => original(address, port, (error, bound) => {
    complete = () => callback!(error, bound)
  }))
  const starting = manager.autoStart(hostId)
  await vi.waitFor(() => expect(complete).toBeDefined())
  sshd.disconnectAll()
  await vi.waitFor(() => expect(manager.statuses()[0]!.state).toBe('error'))
  complete!(); await starting; lease.release()
  expect(manager.statuses().map((item) => item.state)).toEqual(['error', 'stopped'])
  expect(sshd.acceptedConnections).toBe(1)
})
