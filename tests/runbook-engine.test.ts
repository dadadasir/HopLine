import { describe, expect, it, vi } from 'vitest'
import { RunbookEngine } from '../src/core/runbook/engine'
import type { Exec, ExecResult, Runbook, StepResult } from '../src/core/runbook/types'

const response = (code = 0, stdout = '', stderr = ''): ExecResult => ({ code, stdout, stderr })
function book(sudo = false): Runbook {
  return { id: 'demo', title: 'demo', steps: ['a', 'b', 'c'].map((id) => ({ id, title: id, sudo, check: `check ${id}`, apply: `apply ${id}`, verify: `verify ${id}`, rollback: `rollback ${id}` })) }
}
function fixture(runbook = book(), handler: Exec = async (script) => response(script.startsWith('check') ? 10 : 0)) {
  const exec = vi.fn(handler), results: StepResult[] = []
  const engine = new RunbookEngine(exec, (result) => results.push(result))
  return { runbook, exec, results, engine }
}
describe('runbook engine', () => {
  it('plans all three check statuses, keeps the first line and the full command', async () => {
    const { engine, runbook } = fixture(book(), async (script) => response(script.endsWith('a') ? 0 : script.endsWith('b') ? 10 : 2, 'explanation\nextra'))
    const plan = await engine.plan(runbook, {})
    expect(plan.steps.map((step) => step.status)).toEqual(['already', 'needed', 'unknown'])
    expect(plan.steps.map((step) => step.reason)).toEqual(['explanation', 'explanation', 'explanation'])
    expect(plan.steps[0].command).toBe('apply a')
  })
  it('rechecks needed steps, skips unknown and unselected steps, and reports every result', async () => {
    let planning = true
    const { engine, runbook, exec, results } = fixture(book(), async (script) => response(script === 'check b' ? 2 : planning ? 10 : 0))
    await engine.plan(runbook, {}); planning = false
    expect(await engine.run(runbook, {}, ['a', 'b'])).toEqual({ executed: 0, already: 1, skipped: 2, failed: 0, unavailable: 0 })
    expect(results[1].reason).toContain('无法确认')
    expect(results[2].reason).toBe('未选中')
    expect(exec.mock.calls.map(([script]) => script)).toEqual(['check a', 'check b', 'check c', 'check a'])
  })
  it.each([0, 1])('rolls back verification failure (rollback exit %i) and stops subsequent steps', async (rollbackCode) => {
    const { engine, runbook, results, exec } = fixture(book(), async (script) => response(script.startsWith('check') ? 10 : script === 'verify a' ? 1 : script === 'rollback a' ? rollbackCode : 0, script))
    await engine.plan(runbook, {})
    expect(await engine.run(runbook, {}, ['a', 'b', 'c'])).toMatchObject({ failed: 1, skipped: 2 })
    expect(results[0]).toMatchObject({ rollback: rollbackCode === 0, reason: `验证失败；回滚${rollbackCode ? '失败' : '成功'}` })
    expect(results[0].output).toContain('rollback a')
    expect(results.slice(1).every((result) => result.reason === '前序步骤失败，已停止')).toBe(true)
    expect(exec.mock.calls.some(([script]) => script === 'apply b')).toBe(false)
  })
  it('stops on apply/transport errors without using a possibly stale rollback backup', async () => {
    const { engine, runbook, results, exec } = fixture(book(), async (script) => {
      if (script === 'apply a' || script === 'rollback a') throw new Error('disconnected')
      return response(script.startsWith('check') ? 10 : 0)
    })
    await engine.plan(runbook, {}); await engine.run(runbook, {}, ['a', 'b'])
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'disconnected；执行未完成，未自动回滚' })
    expect(exec.mock.calls.some(([script]) => script === 'rollback a')).toBe(false)
    expect(results[1].reason).toContain('前序')
  })
  it('reports rollback transport failures after apply succeeded', async () => {
    const { engine, runbook, results } = fixture(book(), async (script) => {
      if (script === 'rollback a') throw new Error('offline')
      return response(script.startsWith('check') ? 10 : script === 'verify a' ? 1 : 0)
    })
    await engine.plan(runbook, {}); await engine.run(runbook, {}, ['a', 'b'])
    expect(results[0]).toMatchObject({ status: 'failed', rollback: false, reason: '验证失败；回滚失败' })
  })
  it('finishes the active step including verify before honouring cancellation', async () => {
    const controller = new AbortController()
    const { engine, runbook, exec, results } = fixture(book(), async (script) => {
      if (script === 'apply a') controller.abort()
      return response(script.startsWith('check') ? 10 : 0)
    })
    await engine.plan(runbook, {}); await engine.run(runbook, {}, ['a', 'b', 'c'], { signal: controller.signal })
    expect(results.map((result) => result.status)).toEqual(['executed', 'skipped', 'skipped'])
    expect(results[1].reason).toBe('已取消')
    expect(exec.mock.calls.some(([script]) => script === 'verify a')).toBe(true)
    expect(exec.mock.calls.some(([script, options]) => script === 'apply a' && 'signal' in options)).toBe(false)
  })
  it('rejects running without a matching preview, invalid params and unknown selections', async () => {
    const { engine, runbook, exec } = fixture()
    runbook.params = [{ name: 'TZ', label: 'timezone', pattern: '^[A-Za-z_]+(/[A-Za-z_+-]+)*$' }]
    await expect(engine.run(runbook, { TZ: 'UTC' }, ['a'])).rejects.toThrow('重新检查')
    await expect(engine.plan(runbook, { TZ: 'UTC;rm' })).rejects.toThrow('参数')
    expect(exec).not.toHaveBeenCalled()
    await engine.plan(runbook, { TZ: 'UTC' })
    await expect(engine.run(runbook, { TZ: 'Asia/Shanghai' }, ['a'])).rejects.toThrow('重新检查')
    await expect(engine.run(runbook, { TZ: 'UTC' }, ['alien'])).rejects.toThrow('重新检查')
    await engine.run(runbook, { TZ: 'UTC' }, ['a'])
    await expect(engine.run(runbook, { TZ: 'UTC' }, ['a'])).rejects.toThrow('重新检查')
  })
  it('injects parameters only via env and escapes their preview prefix', async () => {
    const value = "x'\n$(touch pwned); #"
    const { engine, runbook, exec } = fixture()
    runbook.params = [{ name: 'VALUE', label: 'value', pattern: '^[\\s\\S]+$' }]
    const plan = await engine.plan(runbook, { VALUE: value })
    expect(plan.steps[0].command).toContain("HL_VALUE='x'\\''")
    await engine.run(runbook, { VALUE: value }, ['a'])
    for (const [script, options] of exec.mock.calls) {
      expect(script).not.toContain(value)
      expect(options.env.HL_VALUE).toBe(value)
    }
  })
  it('rejects script edits after preview and ignores renderer mutations of planned statuses', async () => {
    const { engine, runbook, exec } = fixture(book(), async () => response(2))
    const plan = await engine.plan(runbook, {})
    plan.steps[0].status = 'needed'
    expect(await engine.run(runbook, {}, ['a'])).toMatchObject({ skipped: 3 })
    await engine.plan(runbook, {}); exec.mockClear()
    runbook.steps[0].apply = 'unpreviewed command'
    await expect(engine.run(runbook, {}, ['a'])).rejects.toThrow('重新检查')
    expect(exec).not.toHaveBeenCalled()
  })
  it('treats thrown or timed-out checks as unknown even if the exit code looks successful', async () => {
    const { engine, runbook, results } = fixture(book(), async (script) => {
      if (script.endsWith('a')) throw new Error('offline')
      return { ...response(script.endsWith('b') ? 0 : 10), timedOut: true }
    })
    expect((await engine.plan(runbook, {})).steps.every((step) => step.status === 'unknown')).toBe(true)
    await engine.run(runbook, {}, ['a', 'b', 'c'])
    expect(results.every((result) => result.status === 'skipped')).toBe(true)
  })
})

describe('sudo and sensitive output', () => {
  const password = 'unique-sudo-password', secret = 'unique-param-secret'
  function sudoFixture(mode: 'root' | 'nopass' | 'password' | 'missing', valid = true) {
    const runbook = book(true)
    runbook.params = [{ name: 'VALUE', label: 'value', pattern: '.+', secret: true }]
    const f = fixture(runbook, async (script, options) => {
      if (script === 'id -u') return response(0, mode === 'root' ? '0\n' : '1000\n')
      if (script === 'command -v sudo') return response(mode === 'missing' ? 1 : 0)
      if (script === 'sudo -n true') return response(mode === 'nopass' ? 0 : 1)
      if (script === "sudo -S -p '' -v") return response(valid ? 0 : 1)
      const actual = options.env.HL_SCRIPT ?? script
      return response(actual.includes('check ') ? 10 : 0, `${password} ${secret} ${'汉'.repeat(2000)}`, secret)
    })
    return { ...f, params: { VALUE: secret } }
  }
  it.each(['root', 'nopass', 'password', 'missing'] as const)('handles %s sudo mode and redacts before truncating output', async (mode) => {
    const { engine, runbook, params, results, exec } = sudoFixture(mode)
    expect((await engine.plan(runbook, params)).sudo).toBe(mode)
    await engine.run(runbook, params, ['a'], { sudoPassword: password })
    expect(results[0].status).toBe(mode === 'missing' ? 'unavailable' : 'executed')
    expect(JSON.stringify(results)).not.toContain(password)
    expect(JSON.stringify(results)).not.toContain(secret)
    expect(Buffer.byteLength(results[0].output)).toBeLessThanOrEqual(4096)
    if (mode !== 'missing') expect(results[0].output).toContain('***')
    for (const [script, options] of exec.mock.calls) {
      expect(script).not.toContain(password)
      expect(JSON.stringify(options.env)).not.toContain(password)
    }
    const validation = exec.mock.calls.filter(([script]) => script === "sudo -S -p '' -v")
    expect(validation).toHaveLength(mode === 'password' ? 1 : 0)
    if (mode === 'password') {
      expect(validation[0][1].stdin).toBe(`${password}\n`)
      const elevated = exec.mock.calls.filter(([script]) => script === 'sudo -S -p \'\' sh -c "$HL_SCRIPT"')
      expect(elevated).toHaveLength(3)
      expect(elevated.every(([, options]) => options.stdin === `${password}\n`)).toBe(true)
      expect(elevated[1][1].env.HL_SCRIPT).toContain(`HL_VALUE='${secret}'`)
    }
  })
  it('rejects an incorrect sudo password before any apply or progress', async () => {
    const { engine, runbook, params, results, exec } = sudoFixture('password', false)
    await engine.plan(runbook, params)
    await expect(engine.run(runbook, params, ['a'], { sudoPassword: password })).rejects.toThrow('sudo 密码不正确')
    expect(results).toEqual([])
    expect(exec.mock.calls.some(([script, options]) => `${script}${options.env.HL_SCRIPT ?? ''}`.includes('apply'))).toBe(false)
  })
  it('does not request a password for an entirely unselected run and honors pre-cancellation', async () => {
    const { engine, runbook, params, exec } = sudoFixture('password')
    await engine.plan(runbook, params); exec.mockClear()
    expect(await engine.run(runbook, params, [])).toMatchObject({ skipped: 3 })
    expect(exec).not.toHaveBeenCalled()
    await engine.plan(runbook, params); exec.mockClear()
    expect(await engine.run(runbook, params, ['a'], { signal: AbortSignal.abort() })).toMatchObject({ skipped: 3 })
    expect(exec).not.toHaveBeenCalled()
  })
})
