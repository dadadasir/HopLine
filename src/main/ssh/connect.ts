import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Duplex, type Readable } from 'node:stream'
import type { BaseAgent, Client, ClientChannel, ConnectConfig, CygwinAgent, GetStreamCallback, IdentityCallback, ParsedKey } from 'ssh2'
import fs from 'node:fs'
import type { AgentConfig, AuthType } from '../../shared/types'
import { fingerprintKey } from '../../core/fingerprint'
import { defaultAgentSocket, expandLocalPath, isVirtualAgentTarget, isWindowsNamedPipe, resolveAsarUnpackedPath } from '../../core/win-platform'
import { openProxySocket, type ProxyEndpoint } from './net'

const PAGEANT_ERRORS: Record<number, string> = {
  10: 'Invalid pagent.exe arguments',
  11: 'Pageant is not running',
  12: 'pagent.exe could not create an mmap',
  13: 'pagent.exe could not set mode for stdin',
  14: 'pagent.exe could not set mode for stdout',
  15: 'pagent.exe did not get expected input payload'
}

export class PageantStream extends Duplex {
  private proc: ChildProcess | null = null
  private buffer: Buffer | null = null

  constructor(private readonly exePath: string) {
    super()
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk
    if (this.buffer.length < 4) {
      cb()
      return
    }
    const len = this.buffer.readUInt32BE(0)
    if (this.buffer.length - 4 < len) {
      cb()
      return
    }
    if (this.buffer.length > 4 + len) {
      cb(new Error('Unexpected multiple agent requests'))
      return
    }
    const payload = this.buffer.subarray(0, 4 + len)
    this.buffer = null
    let failed: Error | null = null
    const proc = spawn(this.exePath, [String(payload.length)], { windowsHide: true })
    this.proc = proc
    proc.stdout.on('data', (data: Buffer) => {
      this.push(data)
    })
    proc.on('error', (err: Error) => {
      failed = err
      cb(err)
    })
    proc.on('close', (code: number | null) => {
      this.proc = null
      if (!failed) {
        const msg = code != null ? PAGEANT_ERRORS[code] : undefined
        cb(msg ? new Error(msg) : null)
      }
    })
    proc.stdin.end(payload)
  }

  private cleanup(): void {
    this.buffer = null
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }

  override _final(cb: (error?: Error | null) => void): void {
    this.cleanup()
    cb()
  }

  override _destroy(err: Error | null, cb: (error: Error | null) => void): void {
    this.cleanup()
    cb(err)
  }
}

type Ssh2Runtime = {
  Client: typeof import('ssh2').Client
  createAgent: (socket: string, identityFile?: string | null) => BaseAgent
}

const lazyRequire = createRequire(import.meta.url)
let ssh2Runtime: Ssh2Runtime | null = null

function loadSsh2(): Ssh2Runtime {
  if (!ssh2Runtime) {
    // Load ssh2 from app.asar so its transitive dependencies (asn1, safer-buffer,
    // bcrypt-pbkdf, tweetnacl, cpu-features) resolve inside the same archive;
    // only the Win32 helper binary pagent.exe is resolved from app.asar.unpacked.
    const mod = lazyRequire('ssh2') as typeof import('ssh2')
    const pagentExe = resolveAsarUnpackedPath(
      path.join(path.dirname(lazyRequire.resolve('ssh2/package.json')), 'util', 'pagent.exe')
    )
    const { Client, OpenSSHAgent, utils } = mod
    class ManagedSshAgent extends OpenSSHAgent {
      private readonly publicKey: Buffer | null
      private readonly cygwin: CygwinAgent | null
      private readonly usePageant: boolean

      constructor(socket: string, private readonly identityFile?: string | null) {
        super(socket)
        this.usePageant = process.platform === 'win32' && socket.toLowerCase() === 'pageant'
        this.cygwin = process.platform === 'win32' && !this.usePageant && !isWindowsNamedPipe(socket) && mod.CygwinAgent
          ? new mod.CygwinAgent(socket)
          : null
        if (identityFile) {
          const parsed = utils.parseKey(fs.readFileSync(expandLocalPath(identityFile)))
          if (parsed instanceof Error || Array.isArray(parsed) || parsed.isPrivateKey()) {
            throw new Error(`无法解析公钥文件：${identityFile}`)
          }
          this.publicKey = parsed.getPublicSSH()
        } else {
          this.publicKey = null
        }
      }

      override getStream(cb: GetStreamCallback): void {
        if (this.usePageant) {
          cb(null, new PageantStream(pagentExe))
          return
        }
        if (this.cygwin) {
          this.cygwin.getStream(cb)
          return
        }
        super.getStream(cb)
      }

      override getIdentities(callback: IdentityCallback<ParsedKey>): void {
        super.getIdentities((error, keys) => {
          if (error) return callback(error)
          if (!this.publicKey) return callback(null, keys ?? [])
          const matches = (keys ?? []).filter((key) => 'getPublicSSH' in key && key.getPublicSSH().equals(this.publicKey!))
          if (!matches.length) return callback(new Error(`agent 中没有与 ${this.identityFile} 匹配的钥匙`))
          callback(null, matches.slice(0, 1))
        })
      }
    }
    ssh2Runtime = {
      Client,
      createAgent: (socket, identityFile) => new ManagedSshAgent(socket, identityFile)
    }
  }
  return ssh2Runtime
}

export function createSshAgent(socket: string, identityFile?: string | null): BaseAgent {
  return loadSsh2().createAgent(socket, identityFile)
}

export interface AuthMaterial {
  agent?: AgentConfig | null
  authType: AuthType
  password: string | null
  privateKey: string | null
  privateKeyPath: string | null
  passphrase: string | null
}

export interface Endpoint {
  host: string
  port: number
  username: string
  auth: AuthMaterial
  connectionTimeoutSec?: number | null
  keepaliveIntervalSec?: number | null
}

export interface HostCheck {
  signal?: AbortSignal
  host: string
  port: number
  fingerprint: string
  keyType: string
}

export interface KeyboardRequest {
  signal?: AbortSignal
  name: string
  instructions: string
  prompts: { prompt: string; echo: boolean }[]
}

export interface OpenedConnection {
  client: Client
  jumps: Client[]
}

/** Internal classification survives friendly messages and jump wrapping. */
export class SshConnectionError extends Error {
  constructor(readonly reason: 'authentication' | 'host-key' | 'connection', message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

export function sshFailureReason(error: unknown): SshConnectionError['reason'] | undefined {
  let current = error
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof SshConnectionError) return current.reason
    current = current.cause
  }
  return undefined
}

export async function connectEndpoint(
  target: Endpoint,
  options: {
    signal?: AbortSignal
    proxy?: ProxyEndpoint | null
    jumps?: Endpoint[]
    verifyHost: (check: HostCheck) => Promise<boolean>
    onKeyboard: (request: KeyboardRequest) => Promise<string[] | null>
  }
): Promise<OpenedConnection> {
  const ssh2 = loadSsh2()
  const jumps: Client[] = []
  const endpoints = [...(options.jumps ?? []), target]
  // The destination's settings govern every SSH handshake in its jump chain.
  const readyTimeout = (target.connectionTimeoutSec ?? 20) * 1000
  const keepaliveInterval = (target.keepaliveIntervalSec ?? 10) * 1000
  try {
    for (const [index, endpoint] of endpoints.entries()) {
      try {
        const previous = jumps.at(-1)
        const sock = previous ? await forwardOut(previous, endpoint.host, endpoint.port)
          : options.proxy ? await openProxySocket(options.proxy, endpoint.host, endpoint.port) : undefined
        const client = await connectClient(ssh2, endpoint, {
          sock, readyTimeout, keepaliveInterval,
          signal: options.signal, verifyHost: options.verifyHost, onKeyboard: options.onKeyboard
        })
        if (index === endpoints.length - 1) return { client, jumps }
        jumps.push(client)
      } catch (error) {
        if (index === endpoints.length - 1) throw error
        throw new Error(`跳板 ${index + 1}（${endpoint.host}:${endpoint.port}）：${friendlySshError(error).message}`, { cause: error })
      }
    }
    throw new Error('没有目标主机')
  } catch (error) {
    for (const jump of jumps.reverse()) jump.end()
    throw error
  }
}

export function openShell(
  client: Client,
  cols: number,
  rows: number
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.shell(
      {
        term: 'xterm-256color',
        cols,
        rows,
        width: Math.max(1, cols * 8),
        height: Math.max(1, rows * 16)
      },
      (error, stream) => {
        if (error || !stream) reject(error ?? new Error('无法打开 shell'))
        else resolve(stream)
      }
    )
  })
}

function connectClient(
  ssh2: Ssh2Runtime,
  endpoint: Endpoint,
  options: {
    sock?: Readable
    signal?: AbortSignal
    readyTimeout: number
    keepaliveInterval: number
    verifyHost: (check: HostCheck) => Promise<boolean>
    onKeyboard: (request: KeyboardRequest) => Promise<string[] | null>
  }
): Promise<Client> {
  const client = new ssh2.Client()
  const lifetime = new AbortController()
  client.once('close', () => lifetime.abort())
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      lifetime.abort()
      options.signal?.removeEventListener('abort', abort)
      client.end()
      options.sock?.destroy()
      reject(error)
    }
    const abort = () => fail(new Error('连接已取消'))
    client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
      const normalized = prompts.map((prompt) => ({ prompt: prompt.prompt, echo: Boolean(prompt.echo) }))
      const stored = endpoint.auth.password
      if (stored && normalized.length === 1 && normalized[0]!.echo === false) { finish([stored]); return }
      void options.onKeyboard({ name, instructions, prompts: normalized, signal: lifetime.signal }).then((answers) => {
        if (!answers) { client.end(); return }
        finish(answers)
      }).catch((error) => {
        if (error instanceof SshConnectionError) fail(error)
        else client.end()
      })
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    client.once('ready', () => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      // Like OpenSSH for interactive sessions: without TCP_NODELAY, Nagle plus delayed ACKs stall small packets (keystrokes, SFTP requests).
      client.setNoDelay(true)
      resolve(client)
    })
    client.on('error', (error: Error) => fail(friendlySshError(error)))
    client.once('timeout', () => fail(new SshConnectionError('connection', '连接超时')))
    client.once('close', () => fail(new SshConnectionError('connection', '连接已断开')))
    try {
      if (options.signal?.aborted) { abort(); return }
      client.connect(buildConfig(ssh2, endpoint, { ...options, signal: lifetime.signal, onFailure: fail }))
    } catch (error) {
      fail(friendlySshError(error))
    }
  })
}

function buildConfig(
  ssh2: Ssh2Runtime,
  endpoint: Endpoint,
  options: {
    sock?: Readable
    signal?: AbortSignal
    readyTimeout: number
    keepaliveInterval: number
    verifyHost: (check: HostCheck) => Promise<boolean>
    onFailure: (error: Error) => void
  }
): ConnectConfig {
  const config: ConnectConfig = {
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.username,
    readyTimeout: options.readyTimeout,
    keepaliveInterval: options.keepaliveInterval,
    keepaliveCountMax: 3,
    tryKeyboard: endpoint.auth.authType === 'keyboard-interactive',
    sock: options.sock,
    hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
      const info = fingerprintKey(key)
      void options
        .verifyHost({ host: endpoint.host, port: endpoint.port, ...info, signal: options.signal })
        .then(
          (ok) => verify(Boolean(ok)),
          (error) => {
            if (error instanceof SshConnectionError) options.onFailure(error)
            else verify(false)
          }
        )
    }
  }
  if (endpoint.auth.authType === 'password' && endpoint.auth.password) {
    config.password = endpoint.auth.password
  }
  if (endpoint.auth.authType === 'keyboard-interactive' && endpoint.auth.password) {
    config.password = endpoint.auth.password
  }
  if (endpoint.auth.authType === 'privateKey') {
    try { config.privateKey = readPrivateKey(endpoint.auth) }
    catch (error) { throw new SshConnectionError('authentication', error instanceof Error ? error.message : '私钥无法读取', error) }
    if (endpoint.auth.passphrase) config.passphrase = endpoint.auth.passphrase
  }
  if (endpoint.auth.authType === 'agent') {
    const agent = endpoint.auth.agent
    const socket = agent?.socket ?? defaultAgentSocket()
    if (!socket?.trim()) {
      throw new SshConnectionError(
        'authentication',
        process.platform === 'win32'
          ? '未找到 Windows SSH Agent，请确认已启动 OpenSSH Authentication Agent 服务或指定 agent 管道'
          : '未找到 ssh-agent（SSH_AUTH_SOCK 为空），请在主机设置里指定 agent socket'
      )
    }
    const file = expandLocalPath(socket)
    if (!isVirtualAgentTarget(file) && !fs.existsSync(file)) {
      throw new SshConnectionError('authentication', `agent socket 不存在：${file}`)
    }
    const useManagedAgent = Boolean(agent?.identityFile) || (process.platform === 'win32' && file.toLowerCase() === 'pageant')
    try { config.agent = useManagedAgent ? ssh2.createAgent(file, agent?.identityFile) : file }
    catch (error) { throw new SshConnectionError('authentication', error instanceof Error ? error.message : 'agent 钥匙不可用', error) }
    config.agentForward = agent?.forward ?? false
  }
  return config
}

function readPrivateKey(auth: AuthMaterial): string {
  if (auth.privateKey?.trim()) return auth.privateKey
  if (!auth.privateKeyPath) throw new Error('没有提供私钥')
  const file = expandLocalPath(auth.privateKeyPath)
  if (!fs.existsSync(file)) throw new Error('私钥文件不存在')
  return fs.readFileSync(file, 'utf8')
}

function forwardOut(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
      if (error || !stream) reject(error ?? new Error('跳板转发失败'))
      else resolve(stream)
    })
  })
}

function friendlySshError(error: unknown): Error {
  if (error instanceof SshConnectionError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/Pageant is not running/i.test(message)) {
    return new SshConnectionError('authentication', 'Pageant 未运行，请先启动 Pageant 并加载密钥', error)
  }
  if (process.platform === 'win32' && /Failed to connect to agent/i.test(message)) {
    return new SshConnectionError(
      'authentication',
      '无法连接 Windows SSH Agent，请确认系统已开启 OpenSSH Authentication Agent 服务或 1Password SSH Agent',
      error
    )
  }
  if (/authentication methods failed/i.test(message)) return new SshConnectionError('authentication', '认证失败，请检查用户名、密码或私钥', error)
  if (error instanceof Error && (error as Error & { level?: string }).level === 'client-authentication') return new SshConnectionError('authentication', message, error)
  if (/Cannot parse privateKey/i.test(message)) return new SshConnectionError('authentication', '私钥无法解析，请确认格式和口令', error)
  if (/timed out/i.test(message)) return new SshConnectionError('connection', '连接超时', error)
  if (/ECONNREFUSED/.test(message)) return new SshConnectionError('connection', '连接被拒绝', error)
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message)) return new SshConnectionError('connection', '找不到主机', error)
  if (/EHOSTUNREACH|ENETUNREACH|ECONNRESET/.test(message)) return new SshConnectionError('connection', '网络不可达', error)
  return error instanceof Error ? error : new Error(message)
}
