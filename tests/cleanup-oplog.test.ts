import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RunbookService } from '../src/main/runbook-service'
import { OpLog } from '../src/main/oplog'
import type { ExecResult } from '../src/main/ssh/pool'
import type { OpLogEntry } from '../src/shared/types'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })
const response = (code: number, stdout = ''): ExecResult => ({ code, stdout, stderr: '', timedOut: false, truncated: false, signal: null })
function fixture(after: number | null = 100, password?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-oplog-')); directories.push(directory)
  let stage: 'preview' | 'before' | 'after' = 'preview'
  const measured: Array<number | null> = []
  const exec = vi.fn(async (_host: string, command: string, options?: { stdin?: string }) => {
    if (password) {
      expect(command).not.toContain(password)
      if (command.includes('sudo -S')) expect(options?.stdin).toBe(`${password}\n`)
    }
    const id = /# cleanup:([a-z-]+)/.exec(command)?.[1]
    if (id) {
      if (id !== 'apt-cache') return response(30, 'cleanup.unavailable')
      const bytes = stage === 'preview' ? 1000 : stage === 'before' ? 800 : after
      measured.push(bytes)
      return bytes === null ? response(20, `measurement unavailable ${password ?? ''}`)
        : response(bytes ? 10 : 0, `bytes=${bytes}\n${password ?? 'fixture'}`)
    }
    if (command.includes('id -u')) return response(0, password ? '1000' : '0')
    if (command.includes('command -v sudo')) return response(0, '/usr/bin/sudo')
    if (command.includes('sudo -n true')) return response(1)
    if (command.includes('apt-get clean')) { stage = 'after'; return response(0, password ?? '') }
    if (command.includes('sudo -S')) return response(0)
    throw new Error('Unexpected fixture command')
  })
  const progress = vi.fn(), log = new OpLog(directory), service = new RunbookService({ exec }, log, () => true, progress)
  return { directory, service, log, progress, exec, measured, before: () => { stage = 'before' } }
}

it('records the original 1000-byte preview while actual release uses the fresh 800-to-100 measurements', async () => {
  const f = fixture()
  const plan = await f.service.plan('host', 'cleanup', {})
  expect(plan.cleanup?.['apt-cache'].bytes).toBe(1000)
  expect(f.log.list('host')).toEqual([])
  f.before()
  expect(await f.service.run('host', plan.id, ['apt-cache'])).toMatchObject({ executed: 1, failed: 0 })
  expect(f.measured).toEqual([1000, 800, 100])
  const row = f.log.list('host').find((entry) => entry.stepId === 'apt-cache')!
  expect(row).toMatchObject({ status: 'executed', cleanup: { estimatedBytes: 1000, actualBytes: 700 } })
  const event = f.progress.mock.calls.find(([event]) => event.result.stepId === 'apt-cache')![0]
  expect(event.cleanup).toEqual({ before: 800, after: 100 })
  expect(row.durationMs).toBe(event.result.durationMs)
  expect(row.durationMs).toBeGreaterThanOrEqual(0)
  expect(new OpLog(f.directory).list('host').find((entry) => entry.stepId === 'apt-cache')?.cleanup).toEqual({ estimatedBytes: 1000, actualBytes: 700 })
})

it('keeps actual release unknown when verification cannot obtain a reliable byte count', async () => {
  const f = fixture(null)
  const plan = await f.service.plan('host', 'cleanup', {}); f.before()
  expect(await f.service.run('host', plan.id, ['apt-cache'])).toMatchObject({ failed: 1 })
  expect(f.log.list('host').find((entry) => entry.stepId === 'apt-cache')).toMatchObject({ status: 'failed', cleanup: { estimatedBytes: 1000, actualBytes: null } })
  expect(f.progress.mock.calls.find(([event]) => event.result.stepId === 'apt-cache')![0].cleanup).toEqual({ before: 800, after: null })
})

it('records a measured zero release even if verification fails because space use increased', async () => {
  const f = fixture(900)
  const plan = await f.service.plan('host', 'cleanup', {}); f.before()
  expect(await f.service.run('host', plan.id, ['apt-cache'])).toMatchObject({ failed: 1 })
  expect(f.log.list('host').find((entry) => entry.stepId === 'apt-cache')).toMatchObject({ status: 'failed', cleanup: { estimatedBytes: 1000, actualBytes: 0 } })
  expect(f.progress.mock.calls.find(([event]) => event.result.stepId === 'apt-cache')![0].cleanup).toEqual({ before: 800, after: 900 })
})

it('stores only numeric or unknown measurements and never adds the password to the new fields, events or operation file', async () => {
  const password = 'cleanup-ledger-private', f = fixture(100, password)
  const plan = await f.service.plan('host', 'cleanup', {}, {}, password); f.before()
  await f.service.run('host', plan.id, ['apt-cache'], password)
  const rows = f.log.list('host')
  expect(rows.find((entry) => entry.stepId === 'apt-cache')?.cleanup).toEqual({ estimatedBytes: 1000, actualBytes: 700 })
  for (const row of rows) {
    expect(row.cleanup).toBeDefined()
    expect(Object.keys(row.cleanup!).sort()).toEqual(['actualBytes', 'estimatedBytes'])
    expect(Object.values(row.cleanup!).every((value) => value === null || typeof value === 'number')).toBe(true)
  }
  expect(JSON.stringify(rows)).not.toContain(password)
  expect(JSON.stringify(f.progress.mock.calls)).not.toContain(password)
  expect(fs.readFileSync(path.join(f.directory, 'host.jsonl'), 'utf8')).not.toContain(password)
})

it('preserves old log entries while validating optional cleanup measurements independently', () => {
  const f = fixture()
  const old: OpLogEntry = { at: 1, runbookId: 'timezone', stepId: 'zone', title: 'timezone.title', status: 'executed', reason: '验证通过', output: '', durationMs: 5 }
  f.log.append('host', old)
  f.log.append('host', { ...old, at: 2, runbookId: 'cleanup', cleanup: { estimatedBytes: 1000, actualBytes: null } })
  fs.appendFileSync(path.join(f.directory, 'host.jsonl'), [
    { ...old, at: 3, cleanup: { estimatedBytes: 'not a size', actualBytes: 1 } },
    { ...old, at: 4, cleanup: { estimatedBytes: 1000, actualBytes: -1 } },
    { ...old, at: 5, cleanup: { estimatedBytes: null, actualBytes: 0, extraneous: 'discard this' } }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  const rows = f.log.list('host')
  expect(rows[0]).toEqual(old)
  expect(rows[1].cleanup).toEqual({ estimatedBytes: 1000, actualBytes: null })
  expect(rows[2]).not.toHaveProperty('cleanup')
  expect(rows[3]).not.toHaveProperty('cleanup')
  expect(rows[4].cleanup).toEqual({ estimatedBytes: null, actualBytes: 0 })
})
