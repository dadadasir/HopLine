import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { Vault } from '../core/vault'
import type { ForwardRule, ForwardStatus } from '../shared/types'
import type { ConnectionPool, Lease } from './ssh/pool'

type Running = {
  hostId: string; rule: ForwardRule; state: ForwardStatus['state']; error?: string
  sockets: Set<Duplex>; cleanup: (() => void)[]; lease?: Lease; pending?: Promise<void>; cancelled: boolean
}

export class ForwardManager {
  private rules = new Map<string, Running>()
  private closed = false
  private drops = new Map<string, number>()
  constructor(private pool: Pick<ConnectionPool, 'acquire'>, private vault: Vault,
    private emit: (channel: string, payload: ForwardStatus[]) => void) {}

  statuses(): ForwardStatus[] {
    return this.vault.listHosts().flatMap((host) => host.forwards.map((rule) => {
      const live = this.rules.get(this.key(host.id, rule.id))
      return { hostId: host.id, ruleId: rule.id, state: live?.state ?? 'stopped', error: live?.error, connections: live?.sockets.size ?? 0 }
    }))
  }
  private key(hostId: string, ruleId: string) { return JSON.stringify([hostId, ruleId]) }
  private changed() { this.emit('forwards:status', this.statuses()) }

  async start(hostId: string, ruleId: string): Promise<void> {
    if (this.closed) throw new Error('转发管理器已关闭')
    const key = this.key(hostId, ruleId), previous = this.rules.get(key)
    if (previous?.pending) {
      await previous.pending
      if (this.closed) throw new Error('转发管理器已关闭')
      if (this.rules.get(key) !== previous) return this.start(hostId, ruleId)
      if (!previous.cancelled) return
    }
    if (previous?.state === 'running') return
    const rule = this.vault.getHost(hostId)?.forwards.find((item) => item.id === ruleId)
    if (!rule) throw new Error('转发规则不存在')
    const live: Running = { hostId, rule: structuredClone(rule), state: 'stopped', sockets: new Set(), cleanup: [], cancelled: false }
    this.rules.set(key, live)
    live.pending = this.open(live).catch((error) => {
      if (!live.cancelled) this.finish(live, error instanceof Error ? error.message : String(error))
      throw error
    }).finally(() => { live.pending = undefined })
    return live.pending
  }

  private async open(live: Running): Promise<void> {
    const { rule } = live, lease = await this.pool.acquire(live.hostId)
    if (live.cancelled) { lease.release(); return }
    live.lease = lease
    live.cleanup.push(lease.onDrop(() => {
      this.drops.set(live.hostId, (this.drops.get(live.hostId) ?? 0) + 1)
      for (const rule of this.rules.values()) if (rule.hostId === live.hostId && !rule.cancelled) this.finish(rule, '连接已断开')
    }))
    if (live.cancelled) return
    if (rule.type === 'remote') {
      const incoming: (info: { destIP: string; destPort: number }, accept: () => Duplex, reject: () => void) => void = (info, accept, reject) => {
        if (info.destIP !== rule.bindHost || info.destPort !== rule.bindPort) return
        if (live.cancelled) { reject(); return }
        const channel = accept(), socket = net.connect({ port: rule.targetPort!, host: rule.targetHost!, allowHalfOpen: true })
        this.bridge(live, socket, channel)
      }
      lease.client.on('tcp connection', incoming)
      live.cleanup.push(() => lease.client.removeListener('tcp connection', incoming))
      await new Promise<void>((resolve, reject) => lease.client.forwardIn(rule.bindHost, rule.bindPort, (error) => error ? reject(error) : resolve()))
      const unforward = () => { lease.client.unforwardIn(rule.bindHost, rule.bindPort, () => {}) }
      if (live.cancelled) { unforward(); return }
      live.cleanup.push(unforward)
    } else {
      // allowHalfOpen: a client that sends EOF right after its request must still receive the reply.
      const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        this.track(live, socket)
        if (rule.type === 'dynamic') socks(socket, (host, port) => this.out(live, socket, host, port, true))
        else this.out(live, socket, rule.targetHost!, rule.targetPort!)
      })
      await new Promise<void>((resolve, reject) => {
        live.cleanup.push(() => { server.close(); server.once('listening', () => server.close()); resolve() })
        server.on('error', (error: NodeJS.ErrnoException) => {
          const message = error.code === 'EADDRINUSE' ? `本地端口 ${rule.bindPort} 已被占用` : error.message
          reject(new Error(message)); if (live.state === 'running') this.finish(live, message)
        })
        server.listen(rule.bindPort, rule.bindHost, resolve)
      })
    }
    if (!live.cancelled) { live.state = 'running'; this.changed() }
  }

  private track(live: Running, socket: Duplex): void {
    live.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => { live.sockets.delete(socket); this.changed() })
    this.changed()
  }
  private bridge(live: Running, socket: Duplex, channel: Duplex): void {
    if (!live.sockets.has(socket)) this.track(live, socket)
    const close = () => channel.destroy()
    live.cleanup.push(close)
    channel.once('close', () => { live.cleanup = live.cleanup.filter((item) => item !== close) })
    channel.on('error', () => socket.destroy())
    channel.once('close', () => socket.destroy())
    socket.once('close', () => channel.destroy())
    socket.pipe(channel).pipe(socket)
  }
  private out(live: Running, socket: net.Socket, host: string, port: number, dynamic = false): void {
    if (live.cancelled) { socket.destroy(); return }
    socket.pause()
    try { live.lease!.client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, host, port, (error, channel) => {
      if (live.cancelled || socket.destroyed) { channel?.destroy(); return }
      if (error) { if (dynamic) socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); else socket.destroy(); return }
      if (dynamic) socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
      this.bridge(live, socket, channel)
    }) } catch { socket.destroy() }
  }
  private finish(live: Running, error?: string): void {
    live.cancelled = true; live.state = error ? 'error' : 'stopped'; live.error = error
    for (const close of live.cleanup.splice(0).reverse()) {
      try { close() } catch { /* A dropped SSH connection can no longer unforward. */ }
    }
    for (const socket of live.sockets) socket.destroy()
    live.sockets.clear(); live.lease?.release(); live.lease = undefined
    this.changed()
  }
  async stop(hostId: string, ruleId: string): Promise<void> {
    const live = this.rules.get(this.key(hostId, ruleId))
    if (!live) return
    this.finish(live)
    await live.pending?.catch(() => {})
  }
  async autoStart(hostId: string): Promise<void> {
    const generation = this.drops.get(hostId)
    for (const rule of this.vault.getHost(hostId)?.forwards ?? []) {
      if (this.drops.get(hostId) !== generation) break
      if (rule.autoStart && !this.closed) await this.start(hostId, rule.id).catch(() => {})
    }
  }
  async reconcile(): Promise<void> {
    await Promise.all([...this.rules.values()].map(async (live) => {
      const rule = this.vault.getHost(live.hostId)?.forwards.find((item) => item.id === live.rule.id)
      if (JSON.stringify(rule) !== JSON.stringify(live.rule)) {
        await this.stop(live.hostId, live.rule.id)
        const key = this.key(live.hostId, live.rule.id)
        if (this.rules.get(key) === live) this.rules.delete(key)
      }
    }))
    this.changed()
  }
  async stopAll(): Promise<void> {
    this.closed = true
    await Promise.all([...this.rules.values()].map((live) => this.stop(live.hostId, live.rule.id)))
  }
}

function socks(socket: net.Socket, connect: (host: string, port: number) => void): void {
  let buffer = Buffer.alloc(0), greeting = true
  const fail = (code: number) => { socket.off('data', read); socket.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])) }
  socket.setTimeout(15_000, () => socket.destroy())
  const read = (data: Buffer) => {
    buffer = Buffer.concat([buffer, data])
    if (greeting) {
      if (buffer.length < 2) return
      if (buffer[0] !== 5) { socket.destroy(); return }
      const length = 2 + buffer[1]!
      if (buffer.length < length) return
      if (!buffer.subarray(2, length).includes(0)) { socket.off('data', read); socket.end(Buffer.from([5, 255])); return }
      socket.write(Buffer.from([5, 0])); buffer = buffer.subarray(length); greeting = false
    }
    if (buffer.length < 4) return
    if (buffer[0] !== 5 || buffer[2] !== 0) { fail(1); return }
    if (buffer[1] !== 1) { fail(7); return }
    const type = buffer[3]
    if (![1, 3, 4].includes(type!)) { fail(8); return }
    if (type === 3 && buffer.length < 5) return
    const start = type === 3 ? 5 : 4, length = type === 1 ? 4 : type === 4 ? 16 : buffer[4]!
    if (buffer.length < start + length + 2) return
    const address = buffer.subarray(start, start + length)
    const host = type === 1 ? [...address].join('.') : type === 4
      ? Array.from({ length: 8 }, (_, i) => address.readUInt16BE(i * 2).toString(16)).join(':') : address.toString()
    const port = buffer.readUInt16BE(start + length)
    if (!host || !port) { fail(1); return }
    socket.pause(); socket.off('data', read); socket.setTimeout(0)
    const rest = buffer.subarray(start + length + 2)
    if (rest.length) socket.unshift(rest)
    connect(host, port)
  }
  socket.on('data', read)
}
