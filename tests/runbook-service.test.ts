import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RunbookService } from '../src/main/runbook-service'
import { OpLog } from '../src/main/oplog'
import type { ExecResult } from '../src/main/ssh/pool'

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-runbook-service-')) })
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
const response = (code = 0, stdout = '', stderr = ''): ExecResult => ({ code, stdout, stderr, signal: null, timedOut: false, truncated: false })
function setup(mode: 'root' | 'password' = 'root') {
  const output = 'super-secret-password'
  const exec = vi.fn(async (_host: string, command: string) => {
    if (command.includes('id -u')) return response(0, mode === 'root' ? '0' : '1000')
    if (command.includes('command -v sudo')) return response()
    if (command.includes('sudo -n true')) return response(1)
    if (command.includes('exit 10')) return response(10)
    return response(0, output, output)
  })
  const log = new OpLog(directory), progress = vi.fn(), exists = vi.fn(() => true)
  return { service: new RunbookService({ exec }, log, exists, progress), exec, log, progress, exists, output }
}
it('requires a server-issued preview, consumes it once, and validates the registry and host', async () => {
  const { service, exec, exists } = setup()
  await expect(service.run('host', 'forged', ['timezone'])).rejects.toThrow('重新检查')
  expect(exec).not.toHaveBeenCalled()
  await expect(service.plan('host', 'arbitrary-script', {})).rejects.toThrow('不存在')
  const plan = await service.plan('host', 'timezone', { TZ: 'UTC' })
  await expect(service.run('other-host', plan.id, ['timezone'])).rejects.toThrow('重新检查')
  await expect(service.run('host', plan.id, ['timezone'])).resolves.toMatchObject({ executed: 1 })
  await expect(service.run('host', plan.id, ['timezone'])).rejects.toThrow('重新检查')
  exists.mockReturnValue(false)
  await expect(service.plan('host', 'timezone', { TZ: 'UTC' })).rejects.toThrow('主机不存在')
})
it('locks per host during both plan and run, permits other hosts, and releases after failure', async () => {
  const { service, exec } = setup()
  let resume!: (value: ExecResult) => void
  exec.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
  const checking = service.plan('host', 'timezone', { TZ: 'UTC' })
  await expect(service.plan('host', 'timezone', { TZ: 'UTC' })).rejects.toThrow('已有剧本')
  await expect(service.run('host', 'id', [])).rejects.toThrow('已有剧本')
  await expect(service.plan('other', 'timezone', { TZ: 'UTC' })).resolves.toHaveProperty('id')
  resume(response(0, '0')); const plan = await checking
  exec.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
  const running = service.run('host', plan.id, ['timezone'])
  await expect(service.run('host', plan.id, ['timezone'])).rejects.toThrow('已有剧本')
  resume(response(0, '0')); await running
  exec.mockRejectedValueOnce(new Error('offline'))
  await expect(service.plan('host', 'timezone', { TZ: 'UTC' })).rejects.toThrow('offline')
  await expect(service.plan('host', 'timezone', { TZ: 'UTC' })).resolves.toHaveProperty('id')
})
it('emits correlated progress and persists only redacted results; passwords are stdin-only', async () => {
  const { service, exec, progress, log, output } = setup('password')
  const plan = await service.plan('host', 'timezone', { TZ: 'UTC' })
  await service.run('host', plan.id, ['timezone'], output)
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host', planId: plan.id, result: expect.objectContaining({ status: 'executed' }) }))
  expect(JSON.stringify(progress.mock.calls)).not.toContain(output)
  expect(JSON.stringify(log.list('host'))).not.toContain(output)
  expect(fs.readFileSync(path.join(directory, 'host.jsonl'), 'utf8')).not.toContain(output)
  expect(exec.mock.calls.every(([, command]) => !command.includes(output))).toBe(true)
  expect(log.list('host')[0].output).toContain('***')
})
it('deleting a host invalidates its plan and never recreates a deleted log during an active run', async () => {
  const { service, exec, log, exists } = setup()
  const first = await service.plan('host', 'timezone', { TZ: 'UTC' })
  await service.run('host', first.id, ['timezone'])
  const plan = await service.plan('host', 'timezone', { TZ: 'UTC' })
  let resume!: (value: ExecResult) => void
  exec.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
  const running = service.run('host', plan.id, ['timezone'])
  exists.mockReturnValue(false); service.deleteHost('host')
  resume(response(0, '0')); await running
  expect(log.list('host')).toEqual([])
  expect(fs.existsSync(path.join(directory, 'host.jsonl'))).toBe(false)
  exists.mockReturnValue(true)
  await expect(service.run('host', plan.id, ['timezone'])).rejects.toThrow('重新检查')
})

it('scopes cancellation to its preview or active plan while retaining legacy host cancellation', async () => {
  const { service, exec } = setup()
  const old = await service.plan('host', 'timezone', { TZ: 'UTC' })
  const current = await service.plan('host', 'timezone', { TZ: 'UTC' })
  service.cancel('host', old.id)
  let resume!: (value: ExecResult) => void
  exec.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
  const running = service.run('host', current.id, ['timezone'])
  service.cancel('host', old.id)
  resume(response(0, '0'))
  expect(await running).toMatchObject({ executed: 1, skipped: 0 })

  const next = await service.plan('host', 'timezone', { TZ: 'UTC' })
  exec.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
  const stopping = service.run('host', next.id, ['timezone'])
  service.cancel('host', next.id)
  resume(response(0, '0'))
  expect(await stopping).toMatchObject({ executed: 0, skipped: 1 })

  const scopedPreview = await service.plan('host', 'timezone', { TZ: 'UTC' })
  service.cancel('host', scopedPreview.id)
  await expect(service.run('host', scopedPreview.id, ['timezone'])).rejects.toThrow('重新检查')
  const legacy = await service.plan('host', 'timezone', { TZ: 'UTC' })
  service.cancel('host')
  await expect(service.run('host', legacy.id, ['timezone'])).rejects.toThrow('重新检查')
})
