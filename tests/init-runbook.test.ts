import { spawnSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { initRunbook } from '../src/core/runbook/init'
import { RunbookEngine, envCommand } from '../src/core/runbook/engine'
import { timezoneRunbook } from '../src/core/runbook/samples'
import type { Exec, StepResult } from '../src/core/runbook/types'

export const params = { USER: 'newadmin', PUBKEY: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEtest only-test', USER_PASSWORD: 'new-user-password', SWAP_MB: '2048', TZ: 'UTC' }
it('has nine complete steps, reuses timezone, and every script parses as POSIX sh without executing', () => {
  expect(initRunbook.steps).toHaveLength(9)
  expect(initRunbook.steps.find((step) => step.id === 'timezone')).toBe(timezoneRunbook.steps[0])
  for (const step of initRunbook.steps) for (const script of [step.check, step.apply, step.verify, step.rollback].filter(Boolean)) {
    const result = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' })
    expect(result.stderr, step.id).toBe(''); expect(result.status, step.id).toBe(0)
  }
})
it('validates usernames, single-line keys, passwords, timezone and all swap boundaries', () => {
  const valid = (name: string, value: string) => new RegExp(initRunbook.params!.find((param) => param.name === name)!.pattern).test(value)
  for (const user of ['root', 'ROOT', '-bad', 'u;whoami', 'a'.repeat(33), 'a\nb']) expect(valid('USER', user)).toBe(false)
  for (const user of ['admin', '_admin', 'a-0', 'a'.repeat(32)]) expect(valid('USER', user)).toBe(true)
  for (let value = 0; value <= 17000; value++) expect(valid('SWAP_MB', String(value))).toBe(value >= 256 && value <= 16384)
  for (const value of ['', '256', '16384']) expect(valid('SWAP_MB', value)).toBe(true)
  for (const value of ['0256', '256.5', '-1']) expect(valid('SWAP_MB', value)).toBe(false)
  expect(valid('PUBKEY', params.PUBKEY)).toBe(true)
  for (const value of [`${params.PUBKEY}\nbad`, `${params.PUBKEY}\rbad`, 'x AAAA']) expect(valid('PUBKEY', value)).toBe(false)
  for (const value of ['', 'pw\nextra', 'pw\r', 'pw\0']) expect(valid('USER_PASSWORD', value)).toBe(false)
  expect(valid('TZ', 'Europe/London')).toBe(true); expect(valid('TZ', '../UTC')).toBe(false)
})
it('keeps new-user password out of every command, environment, preview, and output', async () => {
  const results: StepResult[] = []
  const exec = vi.fn<Exec>(async (script) => ({ code: script === 'id -u' ? 0 : initRunbook.steps.some((step) => step.check === script) ? 10 : 0,
    stdout: script === 'id -u' ? '0' : params.USER_PASSWORD, stderr: params.USER_PASSWORD }))
  const engine = new RunbookEngine(exec, (result) => results.push(result), { 'login-as-new-user': async () => ({ ok: true }) })
  expect(JSON.stringify(await engine.plan(initRunbook, params))).not.toContain(params.USER_PASSWORD)
  expect(await engine.run(initRunbook, params, initRunbook.steps.map((step) => step.id))).toMatchObject({ executed: 9 })
  for (const [script, options] of exec.mock.calls) {
    expect(envCommand(script, options.env)).not.toContain(params.USER_PASSWORD)
    expect(options.stdin).toBe(script === initRunbook.steps[0].apply ? `${params.USER_PASSWORD}\n` : undefined)
  }
  expect(JSON.stringify(results)).not.toContain(params.USER_PASSWORD)
})
it('enforces allow-before-enable and syntax-test-before-reload with restore branches', () => {
  const firewall = initRunbook.steps.find((step) => step.id === 'firewall')!.apply
  expect(firewall.indexOf('ufw allow')).toBeLessThan(firewall.indexOf('ufw --force enable'))
  expect(firewall.indexOf('ufw show added')).toBeLessThan(firewall.indexOf('ufw --force enable'))
  expect(firewall.indexOf('firewall-offline-cmd --add-port')).toBeLessThan(firewall.indexOf('enable --now firewalld'))
  expect(firewall).toContain('sshd -T'); expect(firewall).toContain('SSH_CONNECTION'); expect(firewall).toContain('exit 30')
  for (const step of initRunbook.steps.filter((step) => step.id.startsWith('ssh-'))) {
    expect(step.gate).toBe('login-as-new-user'); expect(step.dangerous).toBe(true)
    expect(step.apply.indexOf('sshd -t || exit 1')).toBeLessThan(step.apply.indexOf('systemctl reload'))
    expect(step.apply).toContain("trap 'restore' EXIT")
    expect(step.apply).toContain('cp -p "$backup.main" "$main"')
    expect(step.apply).toContain('cp -p "$backup.fragment" "$fragment"')
    expect(step.apply).toContain('rm -f "$fragment"')
    expect(step.rollback).toContain('sshd -t &&')
  }
  expect(initRunbook.steps[0].rollback).toContain('[ -f "$b/created-$HL_USER" ]')
  expect(initRunbook.steps.find((step) => step.id === 'docker')!.apply).not.toMatch(/curl|wget/)
})

it('rejects trailing newlines before any remote command despite JavaScript dollar-anchor behavior', async () => {
  const exec = vi.fn<Exec>()
  const engine = new RunbookEngine(exec)
  for (const name of ['USER', 'PUBKEY', 'USER_PASSWORD', 'SWAP_MB', 'TZ']) {
    await expect(engine.plan(initRunbook, { ...params, [name]: `${params[name as keyof typeof params]}\n` })).rejects.toThrow('参数')
  }
  expect(exec).not.toHaveBeenCalled()
})
