import { afterEach, expect, it, vi } from 'vitest'
import { collectHost } from '../src/main/collect'
import { COLLECT_SCRIPT } from '../src/core/collect/script'
import type { ExecResult } from '../src/main/ssh/exec'

const result: ExecResult = { stdout: '===HOPLINE:uptime===\n12.5 20\n\n#HOPLINE-END\n', stderr: '', code: 0, signal: null, timedOut: false, truncated: false }
afterEach(() => vi.restoreAllMocks())
it('executes exactly one script with bounded output and timeout', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(123)
  const pool = { exec: vi.fn().mockResolvedValue(result) }
  expect(await collectHost(pool, 'host-1')).toMatchObject({ collectedAt: 123, uptime: { status: 'complete', data: { seconds: 12.5 } } })
  expect(pool.exec).toHaveBeenCalledExactlyOnceWith('host-1', 'sh -s', { stdin: COLLECT_SCRIPT, timeoutMs: 15_000, maxOutputBytes: 1 << 20 })
})
it('rethrows the original exec rejection', async () => {
  const error = new Error('connection failed')
  await expect(collectHost({ exec: vi.fn().mockRejectedValue(error) }, 'host')).rejects.toBe(error)
})
it.each([{ timedOut: true }, { code: 1, stderr: 'sh failed' }, { code: null, signal: 'TERM' }])('rejects an unsuccessful exec result: %j', async (change) => {
  await expect(collectHost({ exec: vi.fn().mockResolvedValue({ ...result, ...change }) }, 'host')).rejects.toThrow()
})
it('keeps completed sections but exposes output truncation as unavailable sections', async () => {
  const snapshot = await collectHost({ exec: vi.fn().mockResolvedValue({ ...result, truncated: true, stdout: result.stdout + '===HOPLINE:cpu===\ncores 4\ncpu 1' }) }, 'host')
  expect(snapshot.uptime.status).toBe('complete')
  expect(snapshot.cpu).toMatchObject({ status: 'unavailable', reason: 'error' })
  expect(snapshot.certs.status).toBe('unavailable')
})
