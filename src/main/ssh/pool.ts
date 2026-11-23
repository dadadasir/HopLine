import type { Client } from 'ssh2'
import { createHash } from 'node:crypto'
import type { Vault } from '../../core/vault'
import * as sshConnect from './connect'
import { execOnClient, type ExecOptions, type ExecResult } from './exec'

export type { ExecOptions, ExecResult } from './exec'

export interface Lease {
  readonly hostId: string
  readonly client: Client
  onDrop(listener: (reason: string) => void): () => void
  release(): void
}

export interface PoolOptions {
  idleMs?: number
  verifyHost: (check: sshConnect.HostCheck) => Promise<boolean>
  /** Read-only trust lookup; must never open a prompt or remember a key. */
  verifyHostWithoutPrompt?: (check: sshConnect.HostCheck) => Promise<boolean>
  onKeyboard: (request: sshConnect.KeyboardRequest) => Promise<string[] | null>
}

interface Entry {
  hostId: string
  target: string
  interaction: 'allow' | 'forbid'
  controller: AbortController
  ready: Promise<sshConnect.OpenedConnection>
  opened?: sshConnect.OpenedConnection
  refs: number
  retired: boolean
  dropped?: string
  idle?: NodeJS.Timeout
  listeners: Set<(reason: string) => void>
}

/** Current connections are indexed by host; retired generations live until their leases end. */
export class ConnectionPool {
  private current = new Map<string, Entry>()
  private entries = new Set<Entry>()
  private closed = false
  private closing?: Promise<void>

  constructor(private readonly vault: Vault, private readonly options: PoolOptions) {}

  isOpen(hostId: string): boolean {
    const entry = this.current.get(hostId)
    return !this.closed && !!entry?.opened && !entry.dropped && !entry.retired
  }

  /** Internal authorization identity; never expose encrypted credentials or this digest over IPC. */
  connectionTarget(hostId: string): string {
    const host = this.vault.getHost(hostId)
    if (!host) throw new Error('主机不存在')
    const auth = (row: typeof host | typeof host.jumps[number]) => [row.host, row.port, row.username, row.authType,
      row.passwordEnc, row.privateKeyEnc, row.privateKeyPath, row.passphraseEnc, row.agent]
    return createHash('sha256').update(JSON.stringify([auth(host), host.proxy, host.jumps.map(auth), host.connectionTimeoutSec, host.keepaliveIntervalSec])).digest('hex')
  }

  async acquire(hostId: string, options: { fresh?: boolean; signal?: AbortSignal; interaction?: 'allow' | 'forbid'; expectedTarget?: string } = {}): Promise<Lease> {
    options.signal?.throwIfAborted()
    if (this.closed) throw new Error('连接池已关闭')
    const target = this.connectionTarget(hostId)
    if (options.expectedTarget !== undefined && options.expectedTarget !== target) throw new Error('runbook.targetChanged')
    if (options.fresh) this.invalidate(hostId)
    let entry = this.current.get(hostId)
    if (entry && entry.target !== target) { this.invalidate(hostId); entry = undefined }
    const interaction = options.interaction ?? 'allow'
    if (entry && !entry.opened && interaction === 'forbid' && entry.interaction === 'allow') {
      throw new sshConnect.SshConnectionError('authentication', '认证尚未完成')
    }
    if (!entry) {
      const controller = new AbortController()
      entry = {
        controller,
        hostId, target, interaction, refs: 0, retired: false, listeners: new Set(),
        // Defer opening until the entry is installed, including synchronous failures.
        ready: Promise.resolve().then(() => this.open(hostId, controller.signal, interaction, target))
      }
      const created = entry
      this.current.set(hostId, created)
      this.entries.add(created)
      created.ready = created.ready.then((opened) => {
        created.opened = opened
        const drop = () => this.drop(created, '连接已断开')
        opened.client.on('close', drop)
        opened.client.on('error', drop)
        for (const jump of opened.jumps) {
          jump.on('close', drop)
          jump.on('error', drop)
        }
        if (this.closed || created.dropped) this.drop(created, created.dropped ?? '连接池已关闭')
        return opened
      }, (error: unknown) => {
        created.dropped = '连接建立失败'
        this.forget(created)
        throw error
      })
    }
    clearTimeout(entry.idle)
    // Reservations include callers still waiting for authentication.
    entry.refs++
    const owned = entry
    let abort: (() => void) | undefined
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(abortError())
      options.signal?.addEventListener('abort', abort, { once: true })
    })
    try {
      const { client } = await Promise.race([owned.ready, canceled])
      if (owned.dropped) throw new Error(owned.dropped)
      if (options.expectedTarget !== undefined && options.expectedTarget !== this.connectionTarget(hostId)) throw new Error('runbook.targetChanged')
      let released = false
      const listeners = new Set<(reason: string) => void>()
      const notify = (reason: string) => {
        for (const listener of [...listeners]) {
          listeners.delete(listener)
          // One consumer must not prevent other leases from seeing a disconnect.
          try { listener(reason) } catch { /* Consumer owns its callback errors. */ }
        }
      }
      owned.listeners.add(notify)
      return {
        hostId, client,
        onDrop: (listener) => {
          if (released) return () => {}
          if (owned.dropped) listener(owned.dropped)
          else listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        release: () => {
          if (released) return
          released = true
          listeners.clear()
          owned.listeners.delete(notify)
          this.release(owned)
        }
      }
    } catch (error) {
      this.release(owned)
      const reason = sshConnect.sshFailureReason(error)
      // A foreground caller may arrive while a background handshake is in
      // flight. Its normal prompt flow must remain available after that attempt.
      if (interaction === 'allow' && owned.interaction === 'forbid' &&
        (reason === 'authentication' || reason === 'host-key') && !this.closed && !options.signal?.aborted) {
        return this.acquire(hostId, options)
      }
      throw error
    } finally {
      if (abort) options.signal?.removeEventListener('abort', abort)
    }
  }

  async exec(hostId: string, script: string, options: ExecOptions & { expectedTarget?: string } = {}): Promise<ExecResult> {
    if (options.signal?.aborted) throw abortError()
    const pending = this.acquire(hostId, { signal: options.signal, ...(options.expectedTarget === undefined ? {} : { expectedTarget: options.expectedTarget }) })
    let abort: (() => void) | undefined
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(abortError())
      options.signal?.addEventListener('abort', abort, { once: true })
    })
    let lease: Lease
    try {
      lease = await Promise.race([pending, canceled])
    } catch (error) {
      void pending.then((late) => late.release(), () => {})
      throw error
    } finally {
      if (abort) options.signal?.removeEventListener('abort', abort)
    }
    try {
      options.beforeStart?.()
      return await execOnClient(lease.client, script, options)
    } finally {
      lease.release()
    }
  }

  invalidate(hostId: string): void {
    const entry = this.current.get(hostId)
    if (!entry) return
    this.current.delete(hostId)
    entry.retired = true
    clearTimeout(entry.idle)
    if (entry.refs === 0) this.drop(entry, '连接已更新')
  }

  invalidateAll(): void {
    for (const hostId of this.current.keys()) this.invalidate(hostId)
  }

  closeAll(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const entries = [...this.entries]
    for (const entry of entries) this.drop(entry, '连接池已关闭')
    this.closing = Promise.allSettled(entries.map((entry) => entry.ready)).then(() => {})
    return this.closing
  }

  private release(entry: Entry): void {
    entry.refs--
    if (entry.refs !== 0 || entry.dropped) return
    if (!entry.opened || entry.retired || this.closed) this.drop(entry, '连接已关闭')
    else {
      entry.idle = setTimeout(() => this.drop(entry, '连接空闲超时'), this.options.idleMs ?? 60_000)
      entry.idle.unref()
    }
  }

  private forget(entry: Entry): void {
    if (this.current.get(entry.hostId) === entry) this.current.delete(entry.hostId)
    this.entries.delete(entry)
    clearTimeout(entry.idle)
  }

  private drop(entry: Entry, reason: string): void {
    // An in-flight connection may finish after closeAll marked its entry dropped.
    if (!entry.dropped) {
      entry.dropped = reason
      entry.controller.abort()
      this.forget(entry)
      for (const notify of [...entry.listeners]) notify(reason)
      entry.listeners.clear()
    }
    const opened = entry.opened
    entry.opened = undefined
    opened?.client.end()
    for (const jump of [...(opened?.jumps ?? [])].reverse()) jump.end()
  }

  private open(hostId: string, signal: AbortSignal, interaction: 'allow' | 'forbid', target: string): Promise<sshConnect.OpenedConnection> {
    if (this.closed) throw new Error('连接池已关闭')
    // Opening is deferred: never reread changed credentials into an older reservation.
    if (this.connectionTarget(hostId) !== target) throw new Error('runbook.targetChanged')
    const host = this.vault.getHost(hostId)
    if (!host) throw new Error('主机不存在')
    const secrets = this.vault.secretsOf(host.id)
    if (interaction === 'forbid' && host.authType === 'password' && !secrets.password) {
      throw new sshConnect.SshConnectionError('authentication', '认证失败，请检查用户名、密码或私钥')
    }
    return sshConnect.connectEndpoint({
      host: host.host, port: host.port, username: host.username,
      connectionTimeoutSec: host.connectionTimeoutSec, keepaliveIntervalSec: host.keepaliveIntervalSec,
      auth: {
        authType: host.authType, password: secrets.password, privateKey: secrets.privateKey,
        privateKeyPath: host.privateKeyPath, passphrase: secrets.passphrase, agent: host.agent
      }
    }, {
      signal,
      proxy: host.proxy ? { ...host.proxy, password: secrets.proxyPassword } : null,
      jumps: host.jumps.map((jump, index) => ({
        host: jump.host, port: jump.port, username: jump.username,
        auth: { authType: jump.authType, agent: jump.agent, privateKeyPath: jump.privateKeyPath, ...secrets.jumps[index]! }
      })),
      verifyHost: interaction === 'allow' ? this.options.verifyHost : async check => {
        if (!await this.options.verifyHostWithoutPrompt?.(check)) throw new sshConnect.SshConnectionError('host-key', '主机指纹需要确认')
        return true
      },
      onKeyboard: interaction === 'allow' ? this.options.onKeyboard : async () => {
        throw new sshConnect.SshConnectionError('authentication', '认证需要交互输入')
      }
    })
  }
}

function abortError(): Error {
  return Object.assign(new Error('远程命令已中止'), { name: 'AbortError' })
}
