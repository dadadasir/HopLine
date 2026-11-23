import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RunbookService } from '../src/main/runbook-service'
import { OpLog } from '../src/main/oplog'
import type { ExecResult } from '../src/main/ssh/pool'
const directories: string[] = []
afterEach(() => { directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })) })
const response = (code: number, stdout: string): ExecResult => ({ code, stdout, stderr: '', timedOut: false, truncated: false, signal: null })
it('registers cleanup, preserves details, reports unsupported items, correlates release and is idempotent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-service-')); directories.push(directory)
  let bytes = 1000
  const exec = vi.fn(async (_host: string, command: string) => {
    const id = /# cleanup:([a-z-]+)/.exec(command)?.[1]
    if (id) return id === 'apt-cache' ? response(bytes ? 10 : 0, `bytes=${bytes}\nAPT cached packages`) : response(30, 'cleanup.unavailable')
    if (command.includes('id -u')) return response(0, '0')
    if (command.includes('apt-get clean')) { bytes = 0; return response(0, 'cleaned') }
    throw new Error(`Unexpected command: ${command}`)
  })
  const progress = vi.fn(), log = new OpLog(directory), service = new RunbookService({ exec }, log, () => true, progress)
  const plan = await service.plan('host', 'cleanup', {})
  expect(plan.cleanup?.['apt-cache']).toMatchObject({ bytes: 1000, details: 'APT cached packages' })
  expect(exec.mock.calls.every(([, command]) => !command.includes('apt-get clean'))).toBe(true)
  expect(await service.run('host', plan.id, ['apt-cache'])).toEqual({ executed: 1, unavailable: 12, skipped: 0, already: 0, failed: 0 })
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host', planId: plan.id, result: expect.objectContaining({ stepId: 'apt-cache', status: 'executed' }), cleanup: { before: 1000, after: 0 } }))
  expect(log.list('host').filter((entry) => entry.status === 'unavailable')).toHaveLength(12)
  const again = await service.plan('host', 'cleanup', {})
  expect(await service.run('host', again.id, ['apt-cache'])).toMatchObject({ already: 1, executed: 0, failed: 0 })
  await expect(service.run('host', again.id, ['apt-cache'])).rejects.toThrow('重新检查')
})
it('never applies checks without a valid bytes line', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-service-')); directories.push(directory)
  const exec = vi.fn(async (_host: string, command: string) => command.includes('# cleanup:') ? response(10, 'not an estimate') : response(0, '0'))
  const service = new RunbookService({ exec }, new OpLog(directory), () => true, () => {})
  const plan = await service.plan('host', 'cleanup', {})
  expect(plan.steps.every((step) => step.status === 'unknown')).toBe(true)
  expect(await service.run('host', plan.id, ['apt-cache'])).toMatchObject({ executed: 0, failed: 0, skipped: 13 })
  expect(exec.mock.calls.every(([, command]) => !command.includes('apt-get clean'))).toBe(true)
})

it('redacts echoed passwords from full estimates, progress, errors, operation files and console output', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-secret-')); directories.push(directory)
  const password = 'cleanup-secret-not-for-logs', progress = vi.fn(), log = new OpLog(directory)
  let bytes = 1000
  const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
  const exec = vi.fn(async (_host: string, command: string, options?: { stdin?: string }) => {
    if (command.includes('# cleanup:')) {
      expect(options?.stdin).toBe(`${password}\n`)
      const id = /# cleanup:([a-z-]+)/.exec(command)?.[1]
      return id === 'apt-cache' ? { ...response(bytes ? 10 : 0, `bytes=${bytes}\nreflected: ${password}`), stderr: password } : response(30, `cleanup.unavailable\n${password}`)
    }
    if (command.includes('id -u')) return response(0, '1000')
    if (command.includes('command -v sudo')) return response(0, '/usr/bin/sudo')
    if (command.includes('sudo -n true')) return response(1, '')
    if (command.includes('apt-get clean')) { expect(options?.stdin).toBe(`${password}\n`); bytes = 0; return { ...response(0, password), stderr: password } }
    expect(options?.stdin).toBe(`${password}\n`)
    return response(0, password)
  })
  try {
    const service = new RunbookService({ exec }, log, () => true, progress)
    expect(await service.sudo('host')).toBe('password')
    expect(exec.mock.calls.some(([, command]) => command.includes('# cleanup:'))).toBe(false)
    const plan = await service.plan('host', 'cleanup', {}, {}, password)
    expect(plan.cleanup?.['apt-cache']).toMatchObject({ bytes: 1000, details: 'reflected: ***' })
    expect(JSON.stringify(plan)).not.toContain(password)
    expect(log.list('host')).toEqual([])
    expect(await service.run('host', plan.id, ['apt-cache'], password)).toMatchObject({ executed: 1, failed: 0 })
    expect(JSON.stringify(progress.mock.calls)).not.toContain(password)
    expect(JSON.stringify(log.list('host'))).not.toContain(password)
    expect(fs.readFileSync(path.join(directory, 'host.jsonl'), 'utf8')).not.toContain(password)
    expect(exec.mock.calls.every(([, command]) => !command.includes(password))).toBe(true)
    expect(consoles.flatMap((spy) => spy.mock.calls).flat().join(' ')).not.toContain(password)
    exec.mockImplementation(async () => { throw new Error(`transport echoed ${password}`) })
    await expect(service.plan('host', 'cleanup', {}, {}, password)).rejects.toThrow('transport echoed ***')
    expect(consoles.flatMap((spy) => spy.mock.calls).flat().join(' ')).not.toContain(password)
  } finally { consoles.forEach((spy) => spy.mockRestore()) }
})

it('permission probing validates the host and respects a concurrent runbook lock', async () => {
  let resolve: (value: ExecResult) => void = () => {}
  const exec = vi.fn(() => new Promise<ExecResult>((done) => { resolve = done }))
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-permissions-')); directories.push(directory)
  const service = new RunbookService({ exec }, new OpLog(directory), (id) => id === 'host', () => {})
  await expect(service.sudo('missing')).rejects.toThrow('主机不存在')
  const pending = service.sudo('host')
  await expect(service.sudo('host')).rejects.toThrow('已有剧本')
  resolve(response(0, '0'))
  expect(await pending).toBe('root')
})

it('diagnoses once with ephemeral stdin, redacts results, and does not write operations', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-diagnose-')); directories.push(directory)
  const password = 'diagnostic-private', progress = vi.fn(), log = new OpLog(directory)
  const exec = vi.fn(async (_host: string, command: string, options?: { stdin?: string }) => {
    expect(command).not.toContain(password)
    if (command.includes('HOPLINE-CLEANUP:')) {
      expect(options?.stdin).toBe(`${password}\n`)
      return response(0, `===HOPLINE-CLEANUP:deleted===\n#HOPLINE-SOURCE lsof\np42\nc${password}\nf3\ntREG\nD0x801\ni123\ns100\n#HOPLINE-END\n`)
    }
    if (command.includes('id -u')) return response(0, '1000')
    if (command.includes('command -v sudo')) return response(0, '/usr/bin/sudo')
    return response(1, '')
  })
  const service = new RunbookService({ exec }, log, () => true, progress)
  const data = await service.diagnose('host', password)
  expect(data.deleted).toMatchObject({ status: 'available', data: { totalBytes: 100, files: [{ process: '***' }] } })
  expect(data.inodes.status).toBe('unavailable')
  expect(exec.mock.calls.filter(([, command]) => command.includes('HOPLINE-CLEANUP:'))).toHaveLength(1)
  expect(JSON.stringify(data)).not.toContain(password)
  expect(log.list('host')).toEqual([]); expect(progress).not.toHaveBeenCalled()
  const missing = new RunbookService({ exec: async () => response(1, '') }, log, () => true, progress)
  expect((await missing.diagnose('host')).deleted.status).toBe('unavailable')
})

it('does not corrupt diagnostic measurements when a numeric password matches a byte count', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-numeric-secret-')); directories.push(directory)
  const exec = async (_host: string, command: string) => {
    if (command.includes('HOPLINE-CLEANUP:')) return response(0, '===HOPLINE-CLEANUP:deleted===\n#HOPLINE-SOURCE lsof\np42\ncworker\nf3\ntREG\nD0x801\ni123\ns123456\n#HOPLINE-END\n')
    if (command.includes('id -u')) return response(0, '1000')
    if (command.includes('command -v sudo')) return response(0, '/usr/bin/sudo')
    return response(1, '')
  }
  const log = new OpLog(directory), service = new RunbookService({ exec }, log, () => true, () => {})
  expect((await service.diagnose('host', '123456')).deleted).toMatchObject({ status: 'available', data: { totalBytes: 123456 } })
  expect(log.list('host')).toEqual([])
})
