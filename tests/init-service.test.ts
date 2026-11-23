import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecResult } from '../src/main/ssh/exec'
import { RunbookService } from '../src/main/runbook-service'
import { OpLog } from '../src/main/oplog'
const mocks = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('../src/main/ssh/exec', () => ({ execOnClient: mocks.exec }))
const directories: string[] = []
afterEach(() => { for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true }); directories.length = 0 })
const params = { USER: 'admin', PUBKEY: 'ssh-ed25519 AAAA', USER_PASSWORD: 'new-secret', TZ: 'UTC' }
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'init-service-')); directories.push(directory)
  const response = (command: string): ExecResult => ({ code: command.includes('id -u') && !command.includes('HL_USER') ? 0 : command.includes('exit 10') ? 10 : 0,
    stdout: command.includes('id -u') && !command.includes('HL_USER') ? '0' : '', stderr: '', truncated: false, timedOut: false, signal: null })
  const lease = { client: {} as never, release: vi.fn(), onDrop: vi.fn(), hostId: 'host' }, exec = vi.fn(async (_host: string, command: string) => response(command)), acquire = vi.fn(async () => lease)
  mocks.exec.mockImplementation(async (_client, command) => response(command))
  const log = new OpLog(directory), service = new RunbookService({ exec, acquire }, log, () => true, () => {})
  return { lease, exec, acquire, service, log }
}
it('registers init, normalizes optional swap, pins the original connection before the gate and uses it for every run command', async () => {
  const f = setup(), gate = vi.fn(async () => { expect(f.acquire).toHaveBeenCalledOnce(); expect(f.lease.release).not.toHaveBeenCalled(); return { ok: true as const } })
  const plan = await f.service.plan('host', 'init', params, { 'login-as-new-user': gate })
  expect(plan.steps).toHaveLength(9); expect(JSON.stringify(plan)).not.toContain('new-secret')
  f.exec.mockClear()
  expect(await f.service.run('host', plan.id, ['ssh-disable-password', 'ssh-disable-root'])).toMatchObject({ executed: 2 })
  expect(gate).toHaveBeenCalledOnce(); expect(f.exec).not.toHaveBeenCalled(); expect(f.lease.release).toHaveBeenCalledOnce()
  for (const [client] of mocks.exec.mock.calls) expect(client).toBe(f.lease.client)
  expect(f.log.list('host').filter((row) => row.gate)).toHaveLength(2)
})
it('drops abandoned previews and releases the retained connection after errors', async () => {
  const f = setup(), plan = await f.service.plan('host', 'init', params)
  f.service.cancel('host')
  await expect(f.service.run('host', plan.id, ['ssh-disable-password'])).rejects.toThrow('重新检查')
  const next = await f.service.plan('host', 'init', params)
  mocks.exec.mockRejectedValueOnce(Error('offline'))
  await expect(f.service.run('host', next.id, ['ssh-disable-password'])).rejects.toThrow('offline')
  expect(f.lease.release).toHaveBeenCalledOnce()
})
