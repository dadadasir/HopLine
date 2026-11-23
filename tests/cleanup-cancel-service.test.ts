import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../src/main/ssh/read-only-exec', () => ({ execReadOnly: mocks.read }))
import { RunbookService } from '../src/main/runbook-service'
import { OpLog } from '../src/main/oplog'
import type { ExecResult } from '../src/main/ssh/exec'
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); vi.clearAllMocks() })
const result = (code: number, stdout = ''): ExecResult => ({ code, stdout, stderr: '', timedOut: false, truncated: false, signal: null })
function fixture(execute = async (_host: string, script: string) => result(script.includes('id -u') ? 0 : 10, script.includes('id -u') ? '0' : 'bytes=10\n')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-cancel-service-')); directories.push(directory)
  const exec = vi.fn(execute), acquire = vi.fn(), progress = vi.fn(), log = new OpLog(directory)
  return { exec, progress, log, service: new RunbookService({ exec, acquire }, log, () => true, progress) }
}
it('cancels the initial permission probe only for its owner and releases the host for retry', async () => {
  let started!: () => void, signal: AbortSignal | undefined
  const ready = new Promise<void>(resolve => { started = resolve })
  mocks.read.mockImplementation((_pool, _host, _script, options) => new Promise((_resolve, reject) => {
    signal = options.signal; started()
    signal!.addEventListener('abort', () => reject(new Error('cleanup.readOnlyCanceled')), { once: true })
  }))
  const { service, exec, log, progress } = fixture()
  const pending = service.sudo('host', 'initial-permission')
  const failed = expect(pending).rejects.toThrow('cleanup.readOnlyCanceled')
  await ready
  await expect(service.sudo('host', 'second-permission')).rejects.toThrow('已有剧本')
  service.cancel('host', 'another-panel'); expect(signal?.aborted).toBe(false)
  service.cancel('host', 'initial-permission'); await failed
  expect(mocks.read).toHaveBeenCalledTimes(1)
  expect(mocks.read.mock.calls[0][2]).toContain('id -u')
  expect(exec).not.toHaveBeenCalled(); expect(log.list('host')).toEqual([]); expect(progress).not.toHaveBeenCalled()
  mocks.read.mockResolvedValue(result(0, '0'))
  await expect(service.sudo('host', 'retry-permission')).resolves.toBe('root')
})
it.each(['root', 'missing', 'nopass', 'password'] as const)('preserves the %s permission result using supervised probes', async (mode) => {
  mocks.read.mockImplementation(async (_pool, _host, script) => script.includes('id -u') ? result(0, mode === 'root' ? '0' : '1000')
    : script.includes('command -v sudo') ? result(mode === 'missing' ? 1 : 0, '/usr/bin/sudo') : result(mode === 'nopass' ? 0 : 1))
  const { service, exec } = fixture()
  await expect(service.sudo('host', 'permission')).resolves.toBe(mode)
  expect(exec).not.toHaveBeenCalled()
  for (const call of mocks.read.mock.calls) expect(call[3]).toEqual({ signal: expect.any(AbortSignal) })
})
const failedProbes = ['id -u', 'command -v sudo', 'sudo -n true'].flatMap(command => [
  { command, failure: 'timeout', patch: { timedOut: true } },
  { command, failure: 'incomplete output', patch: { truncated: true } },
  { command, failure: 'signal', patch: { signal: 'TERM' } },
  { command, failure: 'missing exit status', patch: { code: null } }
])
it.each(failedProbes)('does not classify $command $failure as a permission mode', async ({ command, patch }) => {
  mocks.read.mockImplementation(async (_pool, _host, script) => ({ ...result(0, script.includes('id -u') ? '1000' : '/usr/bin/sudo'), ...(script.includes(command) ? patch : {}) }))
  const { service, exec } = fixture()
  await expect(service.sudo('host', 'permission')).rejects.toThrow('无法探测 root 权限')
  expect(mocks.read).toHaveBeenCalledTimes(['id -u', 'command -v sudo', 'sudo -n true'].indexOf(command) + 1)
  expect(exec).not.toHaveBeenCalled()
})
it('preserves an unconfirmed permission stop and never falls back to an unsupervised scoped probe', async () => {
  mocks.read.mockRejectedValue(new Error('cleanup.cancelUnconfirmed'))
  const { service, exec, log } = fixture()
  await expect(service.sudo('host', 'permission')).rejects.toThrow('cleanup.cancelUnconfirmed')
  const legacyOnly = new RunbookService({ exec }, log, () => true, () => {})
  await expect(legacyOnly.sudo('host', 'permission')).rejects.toThrow('cleanup.readOnlyUnavailable')
  expect(exec).not.toHaveBeenCalled()
  await expect(legacyOnly.sudo('host')).resolves.toBe('root')
  expect(exec).toHaveBeenCalledTimes(1)
  expect(exec.mock.calls[0]).toEqual(['host', expect.stringContaining('id -u')])
  expect(mocks.read).toHaveBeenCalledTimes(1)
})
it('routes planning and directory cancellation only to the matching request and never starts another check', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let signal: AbortSignal | undefined
  mocks.read.mockImplementation((_pool, _host, _script, options) => new Promise((_resolve, reject) => {
    signal = options.signal; started()
    signal!.addEventListener('abort', () => reject(new Error('cleanup.readOnlyCanceled')), { once: true })
  }))
  const { service, log, progress } = fixture()
  const pending = service.plan('host', 'cleanup', {}, {}, '', 'owned-check')
  const failed = expect(pending).rejects.toThrow('cleanup.readOnlyCanceled')
  await ready
  service.cancel('host', 'other-check'); expect(signal?.aborted).toBe(false)
  service.cancel('host', 'owned-check'); await failed
  expect(mocks.read).toHaveBeenCalledTimes(1)
  expect(log.list('host')).toEqual([]); expect(progress).not.toHaveBeenCalled()
  const directoryReady = new Promise<void>(resolve => { started = resolve })
  const du = service.directory('host', '/data', 'directory-request')
  const duFailed = expect(du).rejects.toThrow('cleanup.readOnlyCanceled')
  await directoryReady; service.cancel('host', 'owned-check'); expect(signal?.aborted).toBe(false)
  service.cancel('host', 'directory-request'); await duFailed
})
it('preserves unconfirmed-stop errors instead of reporting successful cancellation', async () => {
  mocks.read.mockRejectedValue(new Error('cleanup.cancelUnconfirmed'))
  const { service } = fixture()
  await expect(service.plan('host', 'cleanup', {}, {}, '', 'request')).rejects.toThrow('cleanup.cancelUnconfirmed')
  expect(mocks.read).toHaveBeenCalledTimes(1)
})
it('execution cancellation finishes apply and verify for the current item and never enters the next item', async () => {
  mocks.read.mockImplementation((_pool, _host, script) => Promise.resolve(script.includes('# cleanup:') ? result(10, 'bytes=10\n') : result(0, '0')))
  let applying!: () => void, finishApply!: () => void
  const ready = new Promise<void>(resolve => { applying = resolve })
  const applyDone = new Promise<void>(resolve => { finishApply = resolve })
  const { service, exec } = fixture(async (_host, script) => {
    if (script.includes('# cleanup:')) return result(script.includes('# cleanup:verify') ? 0 : 10, `bytes=${script.includes('# cleanup:verify') ? 0 : 10}\n`)
    if (script.includes('id -u')) return result(0, '0')
    if (script.includes('journalctl --vacuum-size')) { applying(); await applyDone; return result(0) }
    throw new Error('Unexpected apply')
  })
  const plan = await service.plan('host', 'cleanup', {}, {}, '', 'check')
  const checked = mocks.read.mock.calls.length
  const pending = service.run('host', plan.id, ['journal', 'apt-cache'])
  await ready
  service.cancel('host', plan.id); finishApply()
  expect(await pending).toMatchObject({ executed: 1, failed: 0 })
  expect(exec.mock.calls.some(([, script]) => script.includes('# cleanup:journal') && script.includes('# cleanup:verify'))).toBe(true)
  expect(exec.mock.calls.some(([, script]) => script.includes('apt-get clean'))).toBe(false)
  expect(mocks.read).toHaveBeenCalledTimes(checked)
})
