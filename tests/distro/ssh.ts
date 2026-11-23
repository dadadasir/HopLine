import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { DistroTarget } from './harness'

const { Client } = createRequire(import.meta.url)('ssh2') as typeof import('ssh2')

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

// 每条命令独立连接，不经过应用的连接池，也不复用 sudo 的认证状态。
export function execSsh(
  target: DistroTarget,
  user: string,
  command: string,
  input = '',
  password?: string,
  timeoutMs = 30_000
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let finished = false
    const finish = (error?: Error, result?: CommandResult): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      client.destroy()
      if (error) reject(error)
      else resolve(result!)
    }
    const timer = setTimeout(() => finish(new Error(`${target.name} 的 SSH 命令超时`)), timeoutMs)
    client.on('error', (error) => finish(error))
    client.on('close', () => finish(new Error(`${target.name} 的 SSH 连接提前关闭`)))
    client.on('ready', () => {
      client.exec(command, (error, stream) => {
        if (error) return finish(error)
        let stdout = ''
        let stderr = ''
        stream.setEncoding('utf8')
        stream.stderr.setEncoding('utf8')
        stream.on('data', (data: string) => { stdout += data })
        stream.stderr.on('data', (data: string) => { stderr += data })
        stream.on('error', (streamError: Error) => finish(streamError))
        stream.on('close', (code: number | undefined) => finish(undefined, { stdout, stderr, code: code ?? -1 }))
        stream.end(input)
      })
    })
    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: user,
        ...(password === undefined ? { privateKey: readFileSync(target.keyPath) } : { password }),
        readyTimeout: Math.min(timeoutMs, 5_000)
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
