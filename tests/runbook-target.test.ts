import { afterEach, expect, it, vi } from 'vitest'
import { RunbookService } from '../src/main/runbook-service'
import type { ExecOptions, ExecResult } from '../src/main/ssh/exec'
import type { Lease } from '../src/main/ssh/pool'
import type { OpLog } from '../src/main/oplog'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn() }))
vi.mock('../src/main/ssh/exec', () => ({ execOnClient: mocks.exec }))
vi.mock('../src/main/ssh/read-only-exec', () => ({ execReadOnly: mocks.read }))
afterEach(() => vi.clearAllMocks())
const response = (code = 0, stdout = ''): ExecResult => ({ code, stdout, stderr: '', signal: null, timedOut: false, truncated: false })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture(mode: 'root' | 'password' = 'password') {
  let target = 'A'
  const calls: Array<{ target: string; command: string; stdin?: string }> = []
  const progress = vi.fn(), release = vi.fn(), client = { target: 'A' }
  const reply = (command: string) => {
    if (command.includes('# cleanup:verify')) return response(0, 'bytes=0\n')
    if (command.includes('# cleanup:')) return response(10, 'bytes=4096\n')
    if (command.includes('id -u')) return response(0, mode === 'root' ? '0' : '1000')
    if (command.includes('sudo -n true')) return response(1)
    return response()
  }
  const exec = vi.fn(async (_host: string, command: string, options: ExecOptions = {}) => {
    options.beforeStart?.(); calls.push({ target, command, stdin: options.stdin }); return reply(command)
  })
  const lease: Lease = { hostId: 'host', client: client as never, release, onDrop: vi.fn() }
  const acquire = vi.fn(async (_host: string, _options?: unknown) => lease)
  mocks.exec.mockImplementation(async (_client, command, options = {}) => {
    calls.push({ target: client.target, command, stdin: options.stdin }); return reply(command)
  })
  mocks.read.mockImplementation(async (_pool, _host, command, options = {}) => {
    options.beforeStart?.(); calls.push({ target, command, stdin: options.stdin ?? options.sudo?.password }); return reply(command)
  })
  const log = { append: vi.fn(), delete: vi.fn(), hosts: () => [] } as unknown as OpLog
  const service = new RunbookService({ exec, acquire, connectionTarget: () => target }, log, () => true, progress)
  return { service, calls, exec, acquire, release, client, lease, progress, reply, change: () => { target = 'B' } }
}

it('rejects a saved preview after target changes without acquiring or sending its sudo password', async () => {
  const f = fixture(), plan = await f.service.plan('host', 'cleanup', {}, {}, 'fake-sudo')
  f.calls.length = 0; f.change()
  await expect(f.service.run('host', plan.id, ['apt-cache'], 'fake-sudo')).rejects.toThrow('runbook.targetChanged')
  expect(f.calls).toEqual([]); expect(f.acquire).not.toHaveBeenCalled()
})

it('does not continue a scan or retain a preview after the target changes in a check', async () => {
  const f = fixture(), gate = deferred<ExecResult>()
  f.exec.mockImplementationOnce(async () => gate.promise)
  const work = f.service.plan('host', 'cleanup', {}, {}, 'fake-sudo')
  f.change(); gate.resolve(response(0, '1000'))
  await expect(work).rejects.toThrow('runbook.targetChanged')
  expect(f.calls).toEqual([])
})

it('rechecks an awaited run lease, releases it and sends no command when the target changed', async () => {
  const f = fixture(), plan = await f.service.plan('host', 'cleanup', {}, {}, 'fake-sudo'), gate = deferred<Lease>()
  f.calls.length = 0; f.acquire.mockImplementationOnce(() => gate.promise)
  const work = f.service.run('host', plan.id, ['apt-cache'], 'fake-sudo')
  expect(f.acquire).toHaveBeenCalledWith('host', expect.objectContaining({ expectedTarget: 'A' }))
  f.change(); gate.resolve(f.lease)
  await expect(work).rejects.toThrow('runbook.targetChanged')
  expect(f.calls).toEqual([]); expect(f.release).toHaveBeenCalledOnce()
})

it('uses one fixed lease, stops after an in-flight apply on target change and reports an identifiable error', async () => {
  const f = fixture(), plan = await f.service.plan('host', 'cleanup', {}, {}, 'fake-sudo'), started = deferred<void>(), finish = deferred<void>()
  f.calls.length = 0
  mocks.exec.mockImplementation(async (_client, command, options = {}) => {
    f.calls.push({ target: f.client.target, command, stdin: options.stdin })
    if (command.includes('apt-get clean')) { started.resolve(); await finish.promise }
    return f.reply(command)
  })
  const work = f.service.run('host', plan.id, ['apt-cache', 'dnf-cache'], 'fake-sudo')
  await started.promise; f.change(); finish.resolve()
  await expect(work).rejects.toThrow('runbook.targetChanged')
  expect(f.acquire).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce()
  expect(f.calls.every(call => call.target === 'A')).toBe(true)
  expect(f.calls.some(call => call.command.includes('clean packages'))).toBe(false)
  expect(f.progress).toHaveBeenCalled()
  await expect(f.service.disk('host', '/')).rejects.toThrow('runbook.targetChanged')
})

it.each(['root', 'password'] as const)('keeps the %s workflow bound through diagnose/disk/du and requires a fresh permission probe', async mode => {
  const f = fixture(mode)
  await f.service.sudo('host', 'permission')
  f.calls.length = 0; f.change()
  await expect(f.service.plan('host', 'cleanup', {}, {}, 'fake-sudo', 'check')).rejects.toThrow('runbook.targetChanged')
  await expect(f.service.diagnose('host', 'fake-sudo', 'diagnostics')).rejects.toThrow('runbook.targetChanged')
  await expect(f.service.disk('host', '/')).rejects.toThrow('runbook.targetChanged')
  await expect(f.service.directory('host', '/', 'directory')).rejects.toThrow('runbook.targetChanged')
  expect(f.calls).toEqual([])
  await f.service.sudo('host', 'new-permission')
  await expect(f.service.plan('host', 'cleanup', {}, {}, 'new-fake-sudo', 'new-check')).resolves.toHaveProperty('id')
  expect(f.calls.every(call => call.target === 'B')).toBe(true)
})

it('rejects a late disk result after a target edit instead of attributing it to the old cleanup', async () => {
  const f = fixture(), gate = deferred<ExecResult>()
  await f.service.sudo('host', 'permission')
  mocks.read.mockImplementationOnce(async () => gate.promise)
  const work = f.service.disk('host', '/')
  f.change(); gate.resolve(response(0, 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 1000 500 500 50% /\n'))
  await expect(work).rejects.toThrow('runbook.targetChanged')
})

it('keeps successful cleanup and its after measurement on the same authorized target', async () => {
  const f = fixture(), plan = await f.service.plan('host', 'cleanup', {}, {}, 'fake-sudo')
  f.calls.length = 0
  await expect(f.service.run('host', plan.id, ['apt-cache'], 'fake-sudo')).resolves.toMatchObject({ executed: 1 })
  expect(f.acquire).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce()
  expect(f.calls.every(call => call.target === 'A')).toBe(true)
  f.change()
  await expect(f.service.diagnose('host', 'fake-sudo')).rejects.toThrow('runbook.targetChanged')
  await expect(f.service.disk('host', '/')).rejects.toThrow('runbook.targetChanged')
})
