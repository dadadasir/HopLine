import type { Client, ClientChannel } from 'ssh2'

export interface ExecOptions {
  /** Defaults to 30 seconds; zero disables the timeout for long-running extraction. */
  timeoutMs?: number
  stdin?: string
  maxOutputBytes?: number
  signal?: AbortSignal
  /** Internal read-only supervision handshake; never exposed through IPC. */
  onStdout?: (chunk: Buffer) => void
  /** Internal synchronous validation after pool acquisition, before sending. */
  beforeStart?: () => void
}

export interface ExecResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
}

/** Execute on a particular connection, also used by SFTP's same-connection extraction. */
export function execOnClient(client: Client, script: string, options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stream: ClientChannel | undefined
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let bytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const result: ExecResult = { code: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }
    const limit = Math.max(0, options.maxOutputBytes ?? 4 * 1024 * 1024)
    const finish = (error?: Error, close = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      client.removeListener('close', disconnected)
      client.removeListener('error', failed)
      if (close) stream?.close()
      if (error) reject(error)
      else resolve({ ...result, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    }
    const abort = () => finish(Object.assign(new Error('远程命令已中止'), { name: 'AbortError' }), true)
    const failed = (error: Error) => finish(error, true)
    const disconnected = () => finish(new Error('连接已断开'), true)
    if (options.signal?.aborted) { abort(); return }
    options.signal?.addEventListener('abort', abort, { once: true })
    client.on('close', disconnected)
    client.on('error', failed)
    const timeoutMs = options.timeoutMs ?? 30_000
    if (timeoutMs > 0) timer = setTimeout(() => {
      result.timedOut = true
      finish(undefined, true)
    }, timeoutMs)
    const append = (target: Buffer[], chunk: Buffer | string) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const take = Math.min(buffer.length, Math.max(0, limit - bytes))
      if (take < buffer.length) result.truncated = true
      if (take > 0) target.push(Buffer.from(buffer.subarray(0, take)))
      bytes += take
    }
    try {
      client.exec(script, (error, channel) => {
        if (settled) {
          channel?.on('error', () => {})
          channel?.close()
          return
        }
        if (error || !channel) { finish(error ?? new Error('无法执行远程命令')); return }
        stream = channel
        channel.on('error', failed)
        channel.on('data', (chunk: Buffer) => {
          if (!settled) options.onStdout?.(chunk)
          append(stdout, chunk)
        })
        channel.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
        channel.on('exit', (code: number | null, signal?: string) => {
          result.code = typeof code === 'number' ? code : null
          result.signal = signal ?? null
        })
        channel.on('close', (code?: number | null, signal?: string) => {
          if (typeof code === 'number') result.code = code
          if (signal) result.signal = signal
          finish()
        })
        // EOF is required even without input (for example, cat must not wait forever).
        channel.end(options.stdin ?? '')
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)), true)
    }
  })
}
