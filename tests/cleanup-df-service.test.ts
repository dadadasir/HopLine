import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConnectionPool, ExecResult } from '../src/main/ssh/pool'
import { cleanupDfCommand } from '../src/core/cleanup/df'

const mocks = vi.hoisted(() => ({ readOnly: vi.fn() }))
vi.mock('../src/main/ssh/read-only-exec', () => ({ execReadOnly: mocks.readOnly }))
import { RunbookService } from '../src/main/runbook-service'
import { OpLog } from '../src/main/oplog'

let directory: string
const output = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vdb1 1000 800 100 89% /data files\n'
const response = (fields: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: output, stderr: '', timedOut: false, truncated: false, signal: null, ...fields })
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-df-service-')); vi.clearAllMocks(); mocks.readOnly.mockResolvedValue(response()) })
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
function setup(production = false) {
  const exec = vi.fn<ConnectionPool['exec']>().mockResolvedValue(response())
  const pool = production ? { exec, acquire: vi.fn<ConnectionPool['acquire']>() } : { exec }
  const exists = vi.fn(() => true), progress = vi.fn(), log = new OpLog(directory), append = vi.spyOn(log, 'append')
  return { service: new RunbookService(pool, log, exists, progress), exec, pool, exists, progress, log, append }
}

it('measures exactly the selected mount through a bounded read-only command without operation records', async () => {
  const f = setup()
  expect(await f.service.disk('host', '/data files')).toEqual({ filesystem: '/dev/vdb1', mountpoint: '/data files', totalBytes: 1024000, usedBytes: 819200, availableBytes: 102400, usagePercent: 89 })
  expect(f.exec).toHaveBeenCalledWith('host', cleanupDfCommand('/data files'), { signal: expect.any(AbortSignal), timeoutMs: 10_000, maxOutputBytes: 16 * 1024 })
  expect(f.append).not.toHaveBeenCalled(); expect(f.progress).not.toHaveBeenCalled()
  expect(f.log.list('host')).toEqual([]); expect(fs.readdirSync(directory)).toEqual([])
  expect(mocks.readOnly).not.toHaveBeenCalled()
})

it('uses the supervised executor on a production pool and never requests sudo or stdin', async () => {
  const f = setup(true)
  expect(await f.service.disk('host', '/data files')).not.toBeNull()
  expect(mocks.readOnly).toHaveBeenCalledWith({ acquire: expect.any(Function) }, 'host', cleanupDfCommand('/data files'), { signal: expect.any(AbortSignal), timeoutMs: 10_000, maxOutputBytes: 16 * 1024 })
  expect(f.exec).not.toHaveBeenCalled()
  expect(mocks.readOnly.mock.calls[0][3]).not.toHaveProperty('sudo')
  expect(mocks.readOnly.mock.calls[0][3]).not.toHaveProperty('stdin')
})

it.each([
  { code: 1 }, { code: null }, { timedOut: true }, { truncated: true }, { signal: 'TERM' },
  { stdout: '' }, { stdout: output.replace('/data files', '/') }, { stdout: output.replace('1000', '9007199254740992') }
])('returns unknown for an incomplete, invalid or mismatched result: %j', async (fields) => {
  const f = setup(); f.exec.mockResolvedValue(response(fields))
  expect(await f.service.disk('host', '/data files')).toBeNull()
  expect(f.append).not.toHaveBeenCalled()
})

it('returns unknown for transport failures and releases the host lock', async () => {
  const f = setup(true)
  mocks.readOnly.mockRejectedValueOnce(new Error('cleanup.readOnlyUnavailable'))
  expect(await f.service.disk('host', '/data files')).toBeNull()
  expect(await f.service.disk('host', '/data files')).not.toBeNull()
  expect(f.append).not.toHaveBeenCalled()
})

it('rejects invalid hosts and paths before starting a command', async () => {
  const f = setup()
  for (const mount of ['relative', '/bad\npath', '/bad\0path']) await expect(f.service.disk('host', mount)).rejects.toThrow('cleanup.invalidMount')
  f.exists.mockReturnValue(false)
  await expect(f.service.disk('missing', '/data files')).rejects.toThrow('主机不存在')
  expect(f.exec).not.toHaveBeenCalled(); expect(mocks.readOnly).not.toHaveBeenCalled()
})

it('locks only the current host while measuring and discards canceled measurements', async () => {
  const f = setup()
  let resume!: (result: ExecResult) => void
  f.exec.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
  const running = f.service.disk('host', '/data files')
  await expect(f.service.disk('host', '/data files')).rejects.toThrow('已有剧本')
  await expect(f.service.disk('other', '/data files')).resolves.not.toBeNull()
  f.service.cancel('host')
  expect(f.exec.mock.calls[0][2]?.signal?.aborted).toBe(true)
  resume(response()); expect(await running).toBeNull()
  expect(await f.service.disk('host', '/data files')).not.toBeNull()
  expect(f.append).not.toHaveBeenCalled()
})

it('does not publish a late result for a host removed during measurement', async () => {
  const f = setup()
  let resume!: (result: ExecResult) => void
  f.exec.mockImplementationOnce(() => new Promise((resolve) => { resume = resolve }))
  const running = f.service.disk('host', '/data files')
  f.exists.mockReturnValue(false)
  resume(response()); expect(await running).toBeNull()
  expect(f.append).not.toHaveBeenCalled(); expect(f.progress).not.toHaveBeenCalled()
})
