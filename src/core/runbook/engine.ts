import { shellEscape } from '../shell'
import { isKeystoreReadError } from '../../shared/host-secrets'
import type { Gates, GateResult, Exec, ExecResult, Params, Runbook, RunbookPlan, RunbookSummary, StepResult, SudoMode } from './types'

export const envPrefix = (env: Params): string => Object.entries(env).map(([key, value]) => `${key}=${shellEscape(value)}`).join(' ')
export const envCommand = (script: string, env: Params): string => `${envPrefix(env)} sh -c ${shellEscape(script)}`.trim()
const ok = (result: ExecResult): boolean => result.code === 0 && !result.timedOut && !result.signal
const unknown = '无法确认当前状态，为安全起见已跳过'
export function redact(text: string, secrets: string[]): string {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('***')
  return text
}
function environment(book: Runbook, params: Params): Params {
  const env: Params = {}
  for (const param of book.params ?? []) {
    const value = params[param.name]
    if (!/^[A-Z][A-Z0-9_]*$/.test(param.name) || param.name === 'SCRIPT' || typeof value !== 'string' || value.includes('\0') || new RegExp(param.pattern).exec(value)?.[0] !== value) throw new Error('剧本参数不合法')
    if (!book.steps.some((step) => step.stdin === param.name)) env[`HL_${param.name}`] = value
  }
  if (Object.keys(params).some((name) => !book.params?.some((param) => param.name === name))) throw new Error('剧本参数不合法')
  return env
}

export class RunbookEngine {
  private preview?: { book: string; params: string; plan: RunbookPlan }
  constructor(private readonly exec: Exec, private readonly onProgress: (result: StepResult) => void = () => {}, private readonly gates: Gates = {}) {}
  async sudo(): Promise<SudoMode> {
    const uid = await this.exec('id -u', { env: {} })
    if (!ok(uid)) throw new Error('无法探测 root 权限')
    if (uid.stdout.trim() === '0') return 'root'
    if (!ok(await this.exec('command -v sudo', { env: {} }))) return 'missing'
    return ok(await this.exec('sudo -n true', { env: {} })) ? 'nopass' : 'password'
  }
  private async check(script: string, env: Params, exec = this.exec) {
    try {
      const result = await exec(script, { env })
      const status = ok(result) ? 'already' : result.code === 10 && !result.timedOut && !result.signal ? 'needed' : 'unknown'
      return { status, reason: result.stdout.split(/\r?\n/)[0] || (status === 'unknown' ? unknown : `runbook.${status}`) } as const
    } catch (error) {
      if (isKeystoreReadError(error)) throw error
      return { status: 'unknown', reason: unknown } as const
    }
  }
  async plan(book: Runbook, params: Params, sudoPassword?: string): Promise<RunbookPlan> {
    this.preview = undefined
    const definition = JSON.stringify(book)
    const env = environment(book, params), steps: RunbookPlan['steps'] = []
    const secrets = [...(book.params ?? []).filter((p) => p.secret).map((p) => params[p.name]), sudoPassword ?? '']
    try {
      const sudo = book.steps.some((step) => step.sudo) ? await this.sudo() : 'root'
      // Omission retains the original read-only checks. An explicit password (or
      // an empty string for root/NOPASSWD) opts into privileged planning.
      const privileged = sudoPassword !== undefined
      if (privileged && sudo === 'password' && (!sudoPassword || /[\r\n\0]/.test(sudoPassword) || !ok(await this.exec("sudo -S -p '' -v", { stdin: `${sudoPassword}\n`, env: {} })))) throw new Error('sudo 密码不正确')
      for (const step of book.steps) {
        const execute: Exec = (script) => this.exec(step.sudo && sudo !== 'root' ? "sudo -S -p '' sh -c \"$HL_SCRIPT\"" : script, {
          env: step.sudo && sudo !== 'root' ? { HL_SCRIPT: envCommand(script, env) } : env,
          stdin: step.sudo && sudo === 'password' ? `${sudoPassword}\n` : undefined
        })
        const checked = privileged && step.sudo && sudo === 'missing'
          ? { status: 'unknown' as const, reason: '需要 root 权限，但没有 sudo' }
          : await this.check(step.check, env, privileged ? execute : this.exec)
        steps.push({ ...checked, id: step.id, reason: redact(checked.reason, secrets), command: `${envPrefix(env)}\n${step.apply}`.trim() })
      }
      const plan = { steps, sudo }
      this.preview = { book: definition, params: JSON.stringify(params), plan: structuredClone(plan) }
      return plan
    } catch (error) {
      if (isKeystoreReadError(error)) throw error
      throw new Error(redact(error instanceof Error ? error.message : '检查失败', secrets))
    } finally { sudoPassword = undefined; secrets.fill('') }
  }
  async run(book: Runbook, params: Params, selected: string[], options: { sudoPassword?: string; signal?: AbortSignal } = {}): Promise<RunbookSummary> {
    const env = environment(book, params), preview = this.preview
    if (!preview || preview.book !== JSON.stringify(book) || preview.params !== JSON.stringify(params) || selected.some((id) => !book.steps.some((s) => s.id === id))) throw new Error('请重新检查剧本')
    this.preview = undefined
    let password = options.sudoPassword
    const secrets = [...(book.params ?? []).filter((p) => p.secret).map((p) => params[p.name]), password ?? '']
    const clean = (text: string) => new TextDecoder().decode(new TextEncoder().encode(redact(text, secrets)).slice(0, 4096)).replace(/\uFFFD$/, '')
    const summary: RunbookSummary = { executed: 0, already: 0, skipped: 0, unavailable: 0, failed: 0 }
    const gateResults = new Map<string, GateResult>()
    let stopped = false, sudo: SudoMode = 'root'
    try {
      if (!options.signal?.aborted && book.steps.some((s, i) => s.sudo && selected.includes(s.id) && preview.plan.steps[i].status === 'needed')) {
        sudo = await this.sudo()
        if (sudo === 'password' && (!password || /[\r\n\0]/.test(password) || !ok(await this.exec("sudo -S -p '' -v", { stdin: `${password}\n`, env: {} })))) throw new Error('sudo 密码不正确')
      }
      for (const [index, step] of book.steps.entries()) {
        const started = Date.now(), output: string[] = []
        const result: StepResult = { stepId: step.id, title: step.title, status: 'skipped', reason: '未选中', durationMs: 0, output: '' }
        const execute: Exec = async (script) => {
          // sudo may discard HL_*; reintroduce only validated env assignments inside HL_SCRIPT.
          const input = script === step.apply && step.stdin ? `${params[step.stdin]}\n` : undefined
          if (input && /[\r\n\0]/.test(params[step.stdin!])) throw new Error('剧本参数不合法')
          const response = input && step.sudo && sudo !== 'root' ? await this.exec(
            // sudo may consume its password or use a cached ticket; the last line is always the step input.
            `sudo -S -p '' sh -c 'tail -n 1 | sh -c "$1"' sh "$HL_SCRIPT"`,
            { env: { HL_SCRIPT: envCommand(script, env) }, stdin: (sudo === 'password' ? `${password}\n` : '') + input }
          ) : await this.exec(step.sudo && sudo !== 'root' ? "sudo -S -p '' sh -c \"$HL_SCRIPT\"" : script, {
            env: step.sudo && sudo !== 'root' ? { HL_SCRIPT: envCommand(script, env) } : env,
            stdin: step.sudo && sudo === 'password' ? `${password}\n` : input
          })
          output.push(response.stdout, response.stderr)
          return response
        }
        if (stopped) result.reason = '前序步骤失败，已停止'
        else if (options.signal?.aborted) result.reason = '已取消'
        else if (preview.plan.steps[index].status === 'already') Object.assign(result, { status: 'already', reason: preview.plan.steps[index].reason })
        else if (selected.includes(step.id)) {
          if (preview.plan.steps[index].status === 'unknown') result.reason = unknown
          else if (step.sudo && sudo === 'missing') Object.assign(result, { status: 'unavailable', reason: '需要 root 权限，但没有 sudo' })
          else {
            const checked = await this.check(step.check, env, execute)
            if (checked.status !== 'needed') Object.assign(result, { status: checked.status === 'already' ? 'already' : 'skipped', reason: checked.status === 'unknown' ? unknown : checked.reason })
            else {
              let applied = false
              try {
                if (step.gate) {
                  if (!gateResults.has(step.gate)) {
                    try { gateResults.set(step.gate, await this.gates[step.gate]?.(params) ?? { ok: false, reason: 'init.gateMissing' }) }
                    catch { gateResults.set(step.gate, { ok: false, reason: 'init.gateFailed' }) }
                  }
                  const gate = gateResults.get(step.gate)!
                  result.gate = { name: step.gate, ...gate }
                  if (!gate.ok) { result.reason = gate.reason; throw gate }
                  if (options.signal?.aborted) throw { ok: false, reason: '已取消' }
                }
                const appliedResult = await execute(step.apply, { env })
                if (appliedResult.code === 30 && !appliedResult.timedOut && !appliedResult.signal) {
                  result.status = 'unavailable'; throw { ok: false, reason: appliedResult.stdout.trim() || 'init.unavailable' }
                }
                if (!ok(appliedResult)) throw new Error('执行失败')
                applied = true
                if (!ok(await execute(step.verify, { env }))) throw new Error('验证失败')
                Object.assign(result, { status: 'executed', reason: '验证通过' })
              } catch (error) {
                if (error && typeof error === 'object' && 'ok' in error && error.ok === false && 'reason' in error) result.reason = String(error.reason)
                else {
                  stopped = true
                  Object.assign(result, { status: 'failed', reason: error instanceof Error ? error.message : '执行失败' })
                  if (!applied) result.reason += '；执行未完成，未自动回滚'
                  else if (step.rollback) {
                    try { result.rollback = ok(await execute(step.rollback, { env })) } catch { result.rollback = false }
                    result.reason += result.rollback ? '；回滚成功' : '；回滚失败'
                  } else result.reason += '；无回滚脚本'
                }
              }
            }
          }
        }
        if (result.gate?.reason) result.gate.reason = clean(result.gate.reason)
        result.reason = clean(result.reason); result.output = clean(output.join('\n')); result.durationMs = Date.now() - started
        summary[result.status]++
        this.onProgress(result)
      }
      return summary
    } catch (error) {
      if (isKeystoreReadError(error)) throw error
      throw new Error(clean(error instanceof Error ? error.message : '执行失败'))
    } finally { password = undefined; secrets.fill('') }
  }
}
