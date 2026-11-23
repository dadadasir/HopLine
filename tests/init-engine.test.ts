import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { envCommand, RunbookEngine } from '../src/core/runbook/engine'
import type { ExecResult, Runbook, StepResult } from '../src/core/runbook/types'
import { OpLog } from '../src/main/oplog'

const response = (code = 0, stdout = ''): ExecResult => ({ code, stdout, stderr: '' })
const book: Runbook = { id: 'gate-test', title: 'gate-test', steps: ['password', 'root'].map((id) => ({ id, title: id, sudo: false,
  gate: 'login-as-new-user', check: `check ${id}`, apply: `apply ${id}`, verify: `verify ${id}` })) }
it.each([true, false])('caches gate success/failure (%s) once per run, before any apply, and records both results', async (success) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'init-log-')), log = new OpLog(directory), calls: string[] = []
  const gate = vi.fn(async () => { calls.push('gate'); return success ? { ok: true as const } : { ok: false as const, reason: 'cannot log in' } })
  const engine = new RunbookEngine(async (script) => { calls.push(script); return response(script.startsWith('check') ? 10 : 0) },
    (result) => log.append('host', { ...result, at: Date.now(), runbookId: book.id }), { 'login-as-new-user': gate })
  try {
    await engine.plan(book, {}); expect(gate).not.toHaveBeenCalled()
    await engine.run(book, {}, book.steps.map((step) => step.id))
    expect(gate).toHaveBeenCalledOnce()
    expect(log.list('host')).toHaveLength(2)
    for (const result of log.list('host')) {
      expect(result.gate).toMatchObject({ name: 'login-as-new-user', ok: success })
      expect(result.status).toBe(success ? 'executed' : 'skipped')
      if (!success) expect(result.reason).toBe('cannot log in')
    }
    if (success) expect(calls.indexOf('gate')).toBeLessThan(calls.indexOf('apply password'))
    else expect(calls.some((call) => call.startsWith('apply'))).toBe(false)
    await engine.plan(book, {}); await engine.run(book, {}, ['password', 'root'])
    expect(gate).toHaveBeenCalledTimes(2)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
it.each(['missing', 'throws', 'cancel'] as const)('fails closed on %s gate and never executes apply', async (mode) => {
  const results: StepResult[] = [], controller = new AbortController()
  const exec = vi.fn(async (script: string) => response(script.startsWith('check') ? 10 : 0))
  const engine = new RunbookEngine(exec, (result) => results.push(result), mode === 'missing' ? {} : { 'login-as-new-user': async () => {
    if (mode === 'throws') throw Error('untrusted error')
    controller.abort(); return { ok: true }
  } })
  await engine.plan(book, {}); await engine.run(book, {}, ['password', 'root'], { signal: controller.signal })
  expect(results.every((result) => result.status === 'skipped')).toBe(true)
  expect(exec.mock.calls.some(([script]) => script.startsWith('apply'))).toBe(false)
})
it('delivers stdin secrets only to apply, binds previews to their value and redacts gate results/output', async () => {
  const secret = "password-'$(do-not-run)'", results: StepResult[] = []
  const runbook = structuredClone(book)
  runbook.params = [{ name: 'USER_PASSWORD', label: 'password', secret: true, pattern: '.+' }]
  runbook.steps[0].stdin = 'USER_PASSWORD'
  const exec = vi.fn(async (script: string) => response(script.startsWith('check') ? 10 : 0, secret))
  const engine = new RunbookEngine(exec, (result) => results.push(result), { 'login-as-new-user': async () => ({ ok: false, reason: secret }) })
  const params = { USER_PASSWORD: secret }
  const plan = await engine.plan(runbook, params)
  expect(JSON.stringify(plan)).not.toContain(secret)
  await expect(engine.run(runbook, { USER_PASSWORD: 'changed' }, ['password'])).rejects.toThrow('重新检查')
  await engine.run(runbook, params, ['password', 'root'])
  expect(JSON.stringify(results)).not.toContain(secret)
  const allowed = new RunbookEngine(exec, (result) => results.push(result), { 'login-as-new-user': async () => ({ ok: true }) })
  await allowed.plan(runbook, params); await allowed.run(runbook, params, ['password', 'root'])
  for (const [script, options] of (exec.mock.calls as unknown as [string, { env: Record<string, string>; stdin?: string }][])) {
    expect(envCommand(script, options.env)).not.toContain(secret)
    expect(options.stdin).toBe(script === 'apply password' ? `${secret}\n` : undefined)
  }
  expect(JSON.stringify(results)).not.toContain(secret)
})
it('marks exit 30 as unavailable and continues the next step', async () => {
  const runbook = structuredClone(book); runbook.steps.forEach((step) => { delete step.gate })
  const results: StepResult[] = [], engine = new RunbookEngine(async (script) => response(script.startsWith('check') ? 10 : script === 'apply password' ? 30 : 0, 'init.noFirewall'), (result) => results.push(result))
  await engine.plan(runbook, {}); expect(await engine.run(runbook, {}, ['password', 'root'])).toMatchObject({ unavailable: 1, executed: 1 })
  expect(results[0]).toMatchObject({ status: 'unavailable', reason: 'init.noFirewall' })
})
