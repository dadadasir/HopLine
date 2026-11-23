import { isKeystoreReadError } from '../shared/host-secrets'
import path from 'node:path'
import { readJsonFile, writeJsonFile } from '../core/json-file'
import { envCommand, RunbookEngine } from '../core/runbook/engine'
import { SECURITY_SCRIPT } from '../core/security/script'
import { parseSecurity } from '../core/security/parse'
import { evaluate, securityScore } from '../core/security/rules'
import { applySecurityIgnores, redactSecurityReport } from '../core/security/report'
import type { SecurityIgnores, SecurityReport } from '../core/security/types'
import type { ConnectionPool } from './ssh/pool'
import type { OpLog } from './oplog'
import { logError } from './logger'

export class SecurityService {
  private records: Record<string, SecurityReport>
  private ignores: { version: 1; hosts: Record<string, SecurityIgnores> }
  private busy = new Map<string, AbortController>()
  constructor(private readonly directory: string, private readonly pool: Pick<ConnectionPool, 'exec'>, private readonly log: OpLog,
    private readonly exists: (id: string) => boolean, private readonly updated: () => void = () => {}) {
    this.records = readJsonFile(path.join(directory, 'security.json'), (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((r) => !r?.snapshot || !Array.isArray(r.results) || !Number.isFinite(r.score))) throw new Error('Invalid security records')
      return v as typeof this.records
    }, () => ({}), logError)
    this.ignores = readJsonFile(path.join(directory, 'security-ignores.json'), (v) => {
      const row = v as typeof this.ignores
      if (row?.version !== 1 || !row.hosts || typeof row.hosts !== 'object' || Array.isArray(row.hosts) || Object.values(row.hosts).some((rules) => !rules || typeof rules !== 'object' || Object.values(rules).some((r) => !Number.isFinite(r.at) || typeof r.note !== 'string'))) throw new Error('Invalid security ignores')
      return row
    }, () => ({ version: 1, hosts: {} }), logError)
    this.prune()
  }
  latest(id: string): SecurityReport | null { return this.exists(id) && Object.hasOwn(this.records, id) ? structuredClone(this.records[id]) : null }
  async check(id: string, options: { sudoPassword?: string } = {}): Promise<SecurityReport> {
    if (!this.exists(id) || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('主机不存在')
    if (this.busy.has(id)) throw new Error('security.busy')
    let password = options.sudoPassword, output = ''
    if (password !== undefined && (typeof password !== 'string' || password.length > 4096 || /[\r\n\0]/.test(password))) throw new Error('sudo 密码不正确')
    const controller = new AbortController(), started = Date.now(), timer = setTimeout(() => controller.abort(), 60_000)
    this.busy.set(id, controller)
    try {
      const execute = async (script: string, stdin?: string) => {
        const result = await this.pool.exec(id, script, { stdin, timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024, signal: controller.signal })
        if (result.truncated || result.timedOut || result.signal) throw new Error('security.incomplete')
        if (result.stdout.includes('===HOPLINE:')) output = result.stdout
        return result
      }
      const engine = new RunbookEngine((script, { stdin, env }) => execute(envCommand(script, env), stdin))
      const book = { id: 'security-check', title: '安全体检', steps: [{ id: 'security-check', title: '安全体检', sudo: true, check: 'exit 10', apply: SECURITY_SCRIPT, verify: 'true' }] }
      const plan = await engine.plan(book, {})
      if (!password && (plan.sudo === 'password' || plan.sudo === 'missing')) {
        if ((await execute(envCommand(SECURITY_SCRIPT, {}))).code !== 0) throw new Error('security.incomplete')
      } else if ((await engine.run(book, {}, ['security-check'], { sudoPassword: password, signal: controller.signal })).executed !== 1) throw new Error('security.incomplete')
      if (!output || controller.signal.aborted || !this.exists(id)) throw new Error('security.incomplete')
      const snapshot = parseSecurity(output, Date.now()), ignores = this.ignores.hosts[id] ?? {}, results = evaluate(snapshot, ignores, snapshot.collectedAt)
      const report = redactSecurityReport({ snapshot, ignores, results, score: securityScore(results) }, password)
      this.records[id] = report; this.save()
      this.log.append(id, { at: snapshot.collectedAt, runbookId: book.id, stepId: book.id, title: book.title, status: 'executed', durationMs: Date.now() - started, reason: `score=${report.score}; failed=${results.filter((r) => r.status === 'fail' && r.id !== 'ssh-default-port').length}`, output: '' })
      this.updated(); return structuredClone(report)
    } catch (error) {
      if (isKeystoreReadError(error)) throw error
      throw new Error(controller.signal.aborted ? 'security.incomplete' : 'security.checkFailed')
    }
    finally { password = undefined; output = ''; clearTimeout(timer); this.busy.delete(id) }
  }
  ignore(id: string, rule: string, note: string | null): SecurityReport {
    const report = this.latest(id)
    if (!report || !report.results.some((r) => r.id === rule) || (note !== null && (typeof note !== 'string' || note.length > 500))) throw new Error('security.invalid')
    const ignores = { ...report.ignores }
    if (note === null) delete ignores[rule]; else ignores[rule] = { at: Date.now(), note }
    const next = { version: 1 as const, hosts: { ...this.ignores.hosts, [id]: ignores } }
    writeJsonFile(path.join(this.directory, 'security-ignores.json'), next); this.ignores = next
    report.ignores = ignores; report.results = applySecurityIgnores(report, ignores); report.score = securityScore(report.results)
    this.records[id] = report; this.save(); this.updated(); return structuredClone(report)
  }
  prune(): void {
    for (const id of new Set([...Object.keys(this.records), ...Object.keys(this.ignores.hosts), ...this.busy.keys()])) if (!this.exists(id)) {
      this.busy.get(id)?.abort(); delete this.records[id]; delete this.ignores.hosts[id]
      writeJsonFile(path.join(this.directory, 'security-ignores.json'), this.ignores); this.save()
    }
  }
  private save(): void { writeJsonFile(path.join(this.directory, 'security.json'), this.records) }
}
