import type { MainExtContext } from '../../ext/api'
import { envCommand, redact, RunbookEngine } from '../../core/runbook/engine'
import { shellEscape } from '../../core/shell'
import type { ConnectionPool } from '../ssh/pool'
import type { OpLog } from '../oplog'
import type { HostPublic } from '../../shared/types'
import { isKeystoreReadError } from '../../shared/host-secrets'

/** Internal extension service, never a renderer-facing arbitrary-command IPC. */
export function commandServices(pool: Pick<ConnectionPool, 'exec'>, getHost: (id: string) => HostPublic | undefined, log: OpLog): Pick<MainExtContext, 'sudoMode' | 'execute' | 'appendOperation'> {
  const requireHost = (id: string) => {
    const host = typeof id === 'string' ? getHost(id) : undefined
    if (!host) throw new Error('主机不存在 / Host not found')
    return host
  }
  const guardHost = (id: string) => {
    const expected = JSON.stringify(requireHost(id))
    return () => {
      const host = getHost(id)
      if (!host || JSON.stringify(host) !== expected) throw Object.assign(new Error('主机已修改或删除，请重新确认 / Host changed or was deleted; review it again'), { name: 'HostChangedError' })
    }
  }
  const inspectSudo = async (id: string, beforeStart: () => void) => {
    // A shared timestamp is not a password-free policy. Match the execution
    // path's ignored-ticket semantics without changing older runbook callers.
    return new RunbookEngine((script, options) => pool.exec(id, envCommand(script === 'sudo -n true' ? 'sudo -k -n true' : script, options.env), { stdin: options.stdin, timeoutMs: 10_000, maxOutputBytes: 16 * 1024, beforeStart })).sudo()
  }
  return {
    sudoMode: (id) => inspectSudo(id, guardHost(id)),
    async execute(id, request) {
      const beforeStart = guardHost(id)
      if (!request || typeof request.command !== 'string' || !request.command.trim() || request.command.length > 16_384 || request.command.includes('\0') ||
        typeof request.sudo !== 'boolean' || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 3_600_000 ||
        (request.maxOutputBytes !== undefined && (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 0 || request.maxOutputBytes > 4 * 1024 * 1024))) throw new Error('执行参数不合法 / Invalid execution options')
      let password = request.sudoPassword
      if (password !== undefined && (typeof password !== 'string' || /[\r\n\0]/.test(password))) throw new Error('sudo 密码不合法 / Invalid sudo password')
      const secrets = [password ?? '']
      try {
        const mode = request.sudo ? await inspectSudo(id, beforeStart) : 'root'
        if (mode === 'missing') throw new Error('需要 root 权限 / Root permission required')
        if (mode === 'password' && !password) throw new Error('需要 sudo 密码 / Sudo password required')
        beforeStart()
        // Every privileged exec sends its own credential; no shared sudo ticket.
        // Child input is closed even when NOPASSWD means sudo consumes no line.
        const command = mode === 'root' ? request.command : `sudo -k -S -p '' sh -c ${shellEscape(`exec </dev/null\n${request.command}`)}`
        const result = await pool.exec(id, command, { timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes ?? 1024 * 1024, stdin: mode === 'password' ? `${password}\n` : undefined, beforeStart })
        return { ...result, stdout: redact(result.stdout, secrets), stderr: redact(result.stderr, secrets) }
      } catch (error) {
        if (isKeystoreReadError(error)) throw error
        const safe = new Error(redact(error instanceof Error ? error.message : '执行失败 / Execution failed', secrets))
        if (error instanceof Error && error.name === 'HostChangedError') safe.name = error.name
        throw safe
      } finally { password = undefined; secrets.fill('') }
    },
    appendOperation(id, row) {
      requireHost(id)
      if (!row || !Number.isFinite(row.at) || !Number.isFinite(row.durationMs) || row.durationMs < 0 ||
        !['executed', 'already', 'skipped', 'unavailable', 'failed'].includes(row.status) ||
        !['runbookId', 'stepId', 'title', 'reason', 'output'].every(key => typeof row[key as keyof typeof row] === 'string') || row.output.length > 4 * 1024 * 1024) throw new Error('操作记录不合法 / Invalid operation record')
      log.append(id, row)
    }
  }
}
