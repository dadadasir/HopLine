import { describe, expect, it, vi } from 'vitest'
import { envCommand, RunbookEngine } from '../src/core/runbook/engine'
import type { Exec, Runbook, SudoMode } from '../src/core/runbook/types'

const password = 'plan-only-sudo-secret'
const book: Runbook = { id: 'plan-password', title: 'test', steps: ['first', 'second'].map((id) => ({ id, title: id, sudo: true, check: `check ${id}`, apply: `apply ${id}`, verify: `verify ${id}` })) }
const response = (code: number, stdout = '') => ({ code, stdout, stderr: '' })
function fixture(mode: SudoMode, valid = true) {
  const execute: Exec = async (script, options) => {
    if (script === 'id -u') return response(0, mode === 'root' ? '0' : '1000')
    if (script === 'command -v sudo') return response(mode === 'missing' ? 1 : 0)
    if (script === 'sudo -n true') return response(mode === 'nopass' ? 0 : 1)
    if (script === "sudo -S -p '' -v") return response(valid ? 0 : 1, password)
    return response((options.env.HL_SCRIPT ?? script).includes('check ') ? 10 : 0, password)
  }
  const exec = vi.fn(execute), progress = vi.fn(), engine = new RunbookEngine(exec, progress)
  return { engine, exec, progress }
}

describe('optional privileged planning', () => {
  it.each(['root', 'nopass', 'password', 'missing'] as const)('probes %s without running any runbook checks', async (mode) => {
    const { engine, exec } = fixture(mode)
    expect(await engine.sudo()).toBe(mode)
    expect(exec.mock.calls.every(([script]) => ['id -u', 'command -v sudo', 'sudo -n true'].includes(script))).toBe(true)
  })
  it.each(['root', 'nopass', 'password', 'missing'] as const)('keeps omitted-password checks unchanged in %s mode', async (mode) => {
    const { engine, exec } = fixture(mode)
    const plan = await engine.plan(book, {})
    expect(plan.sudo).toBe(mode)
    expect(exec.mock.calls.slice(-2)).toEqual(book.steps.map((step) => [step.check, { env: {} }]))
    expect(exec.mock.calls.some(([script]) => script.startsWith('sudo -S'))).toBe(false)
  })
  it.each(['root', 'nopass', 'password'] as const)('executes each opted-in %s check independently and never embeds the password', async (mode) => {
    const { engine, exec, progress } = fixture(mode)
    const plan = await engine.plan(book, {}, password)
    expect(plan.steps.map((step) => step.status)).toEqual(['needed', 'needed'])
    expect(JSON.stringify(plan)).not.toContain(password)
    expect(progress).not.toHaveBeenCalled()
    const checks = exec.mock.calls.filter(([script, { env }]) => (env.HL_SCRIPT ?? script).includes('check '))
    expect(checks).toHaveLength(2)
    checks.forEach(([script, options], index) => {
      expect(script).toBe(mode === 'root' ? book.steps[index].check : "sudo -S -p '' sh -c \"$HL_SCRIPT\"")
      expect(options.env).toEqual(mode === 'root' ? {} : { HL_SCRIPT: envCommand(book.steps[index].check, {}) })
      expect(options.stdin).toBe(mode === 'password' ? `${password}\n` : undefined)
    })
    for (const [script, { env }] of exec.mock.calls) expect(JSON.stringify({ script, env })).not.toContain(password)
    // Planning must not retain the password: run still requires its own explicit input.
    if (mode === 'password') await expect(engine.run(book, {}, ['first'])).rejects.toThrow('sudo 密码不正确')
  })
  it('does not estimate or apply sudo steps when sudo is missing', async () => {
    const { engine, exec } = fixture('missing')
    const plan = await engine.plan(book, {}, '')
    expect(plan.steps.every((step) => step.status === 'unknown' && step.reason.includes('需要 root 权限'))).toBe(true)
    expect(await engine.run(book, {}, ['first', 'second'])).toMatchObject({ executed: 0, skipped: 2 })
    expect(exec.mock.calls.every(([script]) => ['id -u', 'command -v sudo'].includes(script))).toBe(true)
  })
  it.each(['', 'incorrect', 'line\nbreak', 'nul\0byte'])('rejects invalid credentials before any checks: %j', async (value) => {
    const { engine, exec, progress } = fixture('password', false)
    await expect(engine.plan(book, {}, value)).rejects.toThrow('sudo 密码不正确')
    expect(exec.mock.calls.some(([script, { env }]) => (env.HL_SCRIPT ?? script).includes('check '))).toBe(false)
    expect(progress).not.toHaveBeenCalled()
    await expect(engine.run(book, {}, ['first'], { sudoPassword: password })).rejects.toThrow('请重新检查剧本')
  })
  it('redacts transport failures before exposing a planning error', async () => {
    const engine = new RunbookEngine(async () => { throw new Error(`transport reflected ${password}`) })
    await expect(engine.plan(book, {}, password)).rejects.toThrow('transport reflected ***')
  })
})
