import { cleanupDfCommand, parseCleanupDf } from '../core/cleanup/df'
import { CLEANUP_DIAGNOSTICS_SCRIPT, parseCleanupDiagnostics } from '../core/cleanup/diagnostics'
import { execReadOnly } from './ssh/read-only-exec'
import { cleanupDuCommand, cleanupDuOutput, cleanupExecution, cleanupRunbook } from '../core/runbook/cleanup'
import type { StepResult } from '../core/runbook/types'
import { initRunbook } from '../core/runbook/init'
import { execOnClient } from './ssh/exec'
import type { Gates } from '../core/runbook/types'
import type { Lease } from './ssh/pool'
import { randomUUID } from 'node:crypto'
import { envCommand, redact, RunbookEngine } from '../core/runbook/engine'
import { timezoneRunbook } from '../core/runbook/samples'
import type { Params, Runbook } from '../core/runbook/types'
import type { HostDisk, RunbookPreview, RunbookProgress } from '../shared/types'
import type { ConnectionPool } from './ssh/pool'
import type { OpLog } from './oplog'
import { installShellIntegration, uninstallShellIntegration } from '../core/runbook/shell-integration'
import { isKeystoreReadError } from '../shared/host-secrets'

export class RunbookService {
  shellIntegrationChanged?: (hostId: string, installed: boolean) => void
  private leases = new Map<string, Lease>()
  private busy = new Map<string, AbortController>()
  private activePlans = new Map<string, string>()
  private cleanupTargets = new Map<string, string>()
  private previews = new Map<string, { id: string; target?: string; engine: RunbookEngine; book: Runbook; params: Params; cleanup?: ReturnType<typeof cleanupExecution>; reported: StepResult[] }>()
  constructor(private readonly pool: Pick<ConnectionPool, 'exec'> & Partial<Pick<ConnectionPool, 'acquire' | 'connectionTarget'>>, readonly log: OpLog,
    private readonly exists: (hostId: string) => boolean, private readonly progress: (event: RunbookProgress) => void) {}
  private assertTarget(hostId: string, target: string | undefined): void {
    if (target !== undefined && this.pool.connectionTarget?.(hostId) !== target) throw new Error('runbook.targetChanged')
  }
  private targetGuard(hostId: string, target: string | undefined) {
    return target === undefined ? {} : { expectedTarget: target, beforeStart: () => this.assertTarget(hostId, target) }
  }
  private cleanupTarget(hostId: string): string | undefined {
    return this.cleanupTargets.get(hostId) ?? this.pool.connectionTarget?.(hostId)
  }
  private readPool(hostId: string, target: string | undefined): Pick<ConnectionPool, 'acquire'> {
    return { acquire: async (_id, options) => {
      this.assertTarget(hostId, target)
      const lease = await this.pool.acquire!(hostId, { ...options, ...(target === undefined ? {} : { expectedTarget: target }) })
      try { this.assertTarget(hostId, target); return lease }
      catch (error) { lease.release(); throw error }
    } }
  }
  private lock(hostId: string): AbortController {
    if (!this.exists(hostId)) throw new Error('主机不存在')
    if (this.busy.has(hostId)) throw new Error('这台主机上已有剧本在运行')
    const controller = new AbortController(); this.busy.set(hostId, controller); return controller
  }
  async sudo(hostId: string, requestId?: string) {
    const controller = this.lock(hostId)
    if (requestId !== undefined) this.activePlans.set(hostId, requestId)
    try {
      // A new permission probe explicitly starts a new cleanup workflow. The
      // following scan, diagnostics and before/after df keep this exact target.
      const target = this.pool.connectionTarget?.(hostId)
      if (target !== undefined) this.cleanupTargets.set(hostId, target)
      const mode = await new RunbookEngine(async (script, { env }) => {
        this.assertTarget(hostId, target)
        // Preserve the original probe for older callers. A scoped probe must
        // support remote termination, including each command before sudo exists.
        if (requestId === undefined) return target === undefined ? this.pool.exec(hostId, envCommand(script, env)) : this.pool.exec(hostId, envCommand(script, env), this.targetGuard(hostId, target))
        if (controller.signal.aborted) throw new Error('cleanup.readOnlyCanceled')
        if (!this.pool.acquire) throw new Error('cleanup.readOnlyUnavailable')
        const result = await execReadOnly(this.readPool(hostId, target), hostId, envCommand(script, env), { signal: controller.signal, ...this.targetGuard(hostId, target) })
        if (controller.signal.aborted) throw new Error('cleanup.readOnlyCanceled')
        // Engine.sudo treats ordinary nonzero exits as missing sudo/password
        // required; transport failures must never become those permission modes.
        if (result.timedOut || result.truncated || result.signal || result.code === null) throw new Error('无法探测 root 权限')
        return result
      }).sudo()
      this.assertTarget(hostId, target)
      if (controller.signal.aborted || !this.exists(hostId)) throw new Error(requestId === undefined ? '已取消' : 'cleanup.readOnlyCanceled')
      return mode
    } finally { this.activePlans.delete(hostId); this.busy.delete(hostId) }
  }
  async diagnose(hostId: string, sudoPassword?: string, requestId?: string) {
    const unavailable = (reason: string) => ({ deleted: { status: 'unavailable' as const, reason }, inodes: { status: 'unavailable' as const, reason }, logs: { status: 'unavailable' as const, reason } })
    const controller = this.lock(hostId)
    if (requestId) this.activePlans.set(hostId, requestId)
    try {
      const target = this.cleanupTarget(hostId)
      this.assertTarget(hostId, target)
      const mode = await new RunbookEngine((script, { env }) => requestId && this.pool.acquire
        ? execReadOnly(this.readPool(hostId, target), hostId, envCommand(script, env), { signal: controller.signal, ...this.targetGuard(hostId, target) })
        : this.pool.exec(hostId, envCommand(script, env), this.targetGuard(hostId, target))).sudo()
      this.assertTarget(hostId, target)
      if (mode === 'missing' || mode === 'password' && (!sudoPassword || /[\r\n\0]/.test(sudoPassword))) {
        return unavailable('cleanup.diagnostic.permissionDenied')
      }
      const command = mode === 'root' ? CLEANUP_DIAGNOSTICS_SCRIPT
        : envCommand("sudo -S -p '' sh -c \"$HL_SCRIPT\"", { HL_SCRIPT: CLEANUP_DIAGNOSTICS_SCRIPT })
      const result = requestId && this.pool.acquire
        ? await execReadOnly(this.readPool(hostId, target), hostId, CLEANUP_DIAGNOSTICS_SCRIPT, { signal: controller.signal, sudo: { mode, password: sudoPassword }, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, ...this.targetGuard(hostId, target) })
        : await this.pool.exec(hostId, command, { stdin: mode === 'password' ? `${sudoPassword}\n` : undefined, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, ...this.targetGuard(hostId, target) })
      this.assertTarget(hostId, target)
      if (controller.signal.aborted || !this.exists(hostId)) throw new Error('已取消')
      if (result.timedOut || result.truncated || result.code !== 0 || result.signal) return unavailable('cleanup.diagnostic.commandFailed')
      const parsed = parseCleanupDiagnostics(result.stdout), secrets = [sudoPassword ?? '']
      if (parsed.deleted.status === 'available') for (const file of parsed.deleted.data.files) file.process = redact(file.process, secrets)
      if (parsed.logs.status === 'available') for (const file of parsed.logs.data) file.path = redact(file.path, secrets)
      if (parsed.inodes.status === 'available') {
        for (const disk of parsed.inodes.data) disk.mountpoint = redact(disk.mountpoint, secrets)
        if (parsed.inodes.unavailableMounts) parsed.inodes.unavailableMounts = parsed.inodes.unavailableMounts.map(mount => redact(mount, secrets))
      }
      return parsed
    } catch (error) {
      if (isKeystoreReadError(error) || error instanceof Error && error.message === 'runbook.targetChanged') throw error
      if (controller.signal.aborted) throw new Error(error instanceof Error && error.message === 'cleanup.cancelUnconfirmed' ? error.message : 'cleanup.readOnlyCanceled')
      return unavailable(error instanceof Error && ['cleanup.readOnlyUnavailable', 'cleanup.cancelUnconfirmed'].includes(error.message) ? error.message : 'cleanup.diagnostic.commandFailed')
    } finally { sudoPassword = undefined; this.activePlans.delete(hostId); this.busy.delete(hostId) }
  }
  async disk(hostId: string, mount: string): Promise<HostDisk | null> {
    const command = cleanupDfCommand(mount), controller = this.lock(hostId)
    try {
      const target = this.cleanupTarget(hostId)
      this.assertTarget(hostId, target)
      const options = { signal: controller.signal, timeoutMs: 10_000, maxOutputBytes: 16 * 1024, ...this.targetGuard(hostId, target) }
      const result = this.pool.acquire ? await execReadOnly(this.readPool(hostId, target), hostId, command, options) : await this.pool.exec(hostId, command, options)
      this.assertTarget(hostId, target)
      if (controller.signal.aborted || !this.exists(hostId) || result.code !== 0 || result.timedOut || result.truncated || result.signal) return null
      return parseCleanupDf(result.stdout, mount)
    } catch (error) { if (isKeystoreReadError(error) || error instanceof Error && error.message === 'runbook.targetChanged') throw error; return null }
    finally { this.busy.delete(hostId) }
  }
  async directory(hostId: string, mount: string, requestId?: string) {
    const command = cleanupDuCommand(mount), controller = this.lock(hostId)
    if (requestId) this.activePlans.set(hostId, requestId)
    try {
      const target = this.cleanupTarget(hostId)
      this.assertTarget(hostId, target)
      const options = { signal: controller.signal, timeoutMs: 30_000, maxOutputBytes: 256 * 1024, ...this.targetGuard(hostId, target) }
      const result = this.pool.acquire ? await execReadOnly(this.readPool(hostId, target), hostId, command, options) : await this.pool.exec(hostId, command, options)
      this.assertTarget(hostId, target)
      return { output: cleanupDuOutput(result.stdout, mount), timedOut: result.timedOut, truncated: result.truncated, incomplete: result.code !== 0 || !!result.signal }
    } finally { this.activePlans.delete(hostId); this.busy.delete(hostId) }
  }
  async plan(hostId: string, runbookId: string, params: Params, gates: Gates = {}, sudoPassword?: string, requestId?: string): Promise<RunbookPreview> {
    const controller = this.lock(hostId)
    this.previews.delete(hostId)
    if (requestId) this.activePlans.set(hostId, requestId)
    let planning = true
    let cancellationFailure: string | undefined
    let target: string | undefined
    try {
      const book = [timezoneRunbook, initRunbook, cleanupRunbook, installShellIntegration, uninstallShellIntegration].find((item) => item.id === runbookId)
      if (!book) throw new Error('剧本不存在')
      target = book.id === 'cleanup' ? this.cleanupTarget(hostId) : this.pool.connectionTarget?.(hostId)
      this.assertTarget(hostId, target)
      if (book.id === 'cleanup' && target !== undefined) this.cleanupTargets.set(hostId, target)
      if (book.id === 'init') params = { SWAP_MB: '', ...params }
      const id = randomUUID()
      const execute: import('../core/runbook/types').Exec = async (script, { stdin, env }) => {
        this.assertTarget(hostId, target)
        if (planning && controller.signal.aborted) throw new Error('cleanup.readOnlyCanceled')
        if (planning && requestId && book.id === 'cleanup' && this.pool.acquire ) {
          try {
            return await execReadOnly(this.readPool(hostId, target), hostId, env.HL_SCRIPT ?? envCommand(script, env), { signal: controller.signal, ...this.targetGuard(hostId, target), ...(env.HL_SCRIPT ? { sudo: { mode: stdin ? 'password' as const : 'nopass' as const, password: sudoPassword } } : { stdin }) })
          } catch (error) {
            if (error instanceof Error && error.message === 'cleanup.cancelUnconfirmed') { cancellationFailure = error.message; controller.abort() }
            throw error
          }
        }
        const lease = this.leases.get(hostId), command = envCommand(script, env)
        return lease ? execOnClient(lease.client, command, { stdin, timeoutMs: book.id === 'init' ? 600_000 : 30_000 }) : this.pool.exec(hostId, command, { stdin, ...this.targetGuard(hostId, target) })
      }
      const cleanup = book.id === 'cleanup' ? cleanupExecution(execute) : undefined, reported: StepResult[] = []
      const originalEstimates = new Map<string, number | null>()
      const engine = new RunbookEngine(cleanup?.exec ?? execute, (result) => {
        if (cleanup?.estimates[result.stepId]?.unavailable && result.status === 'skipped' && result.reason === '未选中') Object.assign(result, { status: 'unavailable', reason: 'cleanup.unavailable' })
        reported.push(result)
        if (this.exists(hostId) && ['executed', 'already'].includes(result.status) && [installShellIntegration.id, uninstallShellIntegration.id].includes(result.stepId)) {
          this.shellIntegrationChanged?.(hostId, result.stepId === installShellIntegration.id)
        }
        const measured = cleanup?.changes[result.stepId]
        const cleanupRecord = cleanup ? {
          estimatedBytes: originalEstimates.get(result.stepId) ?? null,
          actualBytes: measured?.before != null && measured.after != null ? Math.max(0, measured.before - measured.after) : null
        } : undefined
        if (this.exists(hostId)) this.log.append(hostId, { ...result, at: Date.now(), runbookId: book.id, ...(cleanupRecord ? { cleanup: cleanupRecord } : {}) })
        this.progress({ hostId, planId: id, result, ...(cleanup ? { cleanup: cleanup.changes[result.stepId] } : {}) })
      }, gates)
      const plan = await engine.plan(book, params, requestId && book.id === 'cleanup' ? sudoPassword ?? '' : sudoPassword)
      this.assertTarget(hostId, target)
      // Runtime checks overwrite cleanup.estimates; retain the exact numbers the
      // user reviewed instead of logging the later pre-apply measurements as estimates.
      if (cleanup) for (const [stepId, estimate] of Object.entries(cleanup.estimates)) originalEstimates.set(stepId, estimate.bytes)
      // The measurement adapter observes full stdout before the engine retains
      // its first line. Scrub those details before storing or returning them.
      if (cleanup) for (const estimate of Object.values(cleanup.estimates)) estimate.details = redact(estimate.details, [sudoPassword ?? ''])
      if (controller.signal.aborted || !this.exists(hostId)) throw new Error(cancellationFailure ?? 'cleanup.readOnlyCanceled')
      this.previews.set(hostId, { id, target, engine, book, params: { ...params }, cleanup, reported })
      return { ...plan, id, ...(cleanup ? { cleanup: cleanup.estimates } : {}) }
    } catch (error) {
      // Engine error redaction must not rewrite this internal control code even
      // when a password happens to contain part of "runbook.targetChanged".
      this.assertTarget(hostId, target)
      throw error
    } finally { planning = false; sudoPassword = undefined; this.activePlans.delete(hostId); this.busy.delete(hostId) }
  }
  async run(hostId: string, planId: string, selected: string[], sudoPassword?: string) {
    const controller = this.lock(hostId)
    let target: string | undefined
    try {
      const preview = this.previews.get(hostId)
      if (!preview || preview.id !== planId) throw new Error('请重新检查剧本')
      target = preview.target
      this.assertTarget(hostId, preview.target)
      this.activePlans.set(hostId, planId)
      this.previews.delete(hostId)
      if (this.pool.acquire && (preview.target !== undefined || preview.book.id === 'init')) {
        const lease = await this.readPool(hostId, preview.target).acquire(hostId, { signal: controller.signal })
        this.leases.set(hostId, lease); lease.onDrop(() => controller.abort())
      }
      const summary = await preview.engine.run(preview.book, preview.params, selected, { sudoPassword, signal: controller.signal })
      // The engine reports individual failures instead of throwing. Target
      // changes must also reach the caller so credentials and stale UI reset.
      this.assertTarget(hostId, preview.target)
      if (preview.cleanup) {
        for (const status of Object.keys(summary) as Array<keyof typeof summary>) summary[status] = preview.reported.filter((result) => result.status === status).length
      }
      return summary
    } catch (error) {
      this.assertTarget(hostId, target)
      throw error
    } finally { this.leases.get(hostId)?.release(); this.leases.delete(hostId); this.activePlans.delete(hostId); sudoPassword = undefined; this.busy.delete(hostId) }
  }
  cancel(hostId: string, planId?: string): void {
    // A stale cleanup panel must not stop another workflow on the same host.
    if (planId === undefined || this.activePlans.get(hostId) === planId) this.busy.get(hostId)?.abort()
    if (planId === undefined || this.previews.get(hostId)?.id === planId) this.previews.delete(hostId)
  }
  deleteHost(hostId: string): void { this.cancel(hostId); this.previews.delete(hostId); this.cleanupTargets.delete(hostId); this.log.delete(hostId) }
  prune(): void {
    for (const id of new Set([...this.log.hosts(), ...this.previews.keys(), ...this.busy.keys(), ...this.cleanupTargets.keys()])) if (!this.exists(id)) this.deleteHost(id)
  }
}
