import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OpLog } from '../src/main/oplog'
import type { OpLogEntry } from '../src/shared/types'

let directory: string, log: OpLog
const row = (at: number): OpLogEntry => ({ at, runbookId: 'demo', stepId: 'a', title: 'A', status: 'executed', reason: 'ok', output: 'done', durationMs: 5 })
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-oplog-')); log = new OpLog(directory) })
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
it('appends, reads, isolates hosts and deletes a host log', () => {
  expect(log.list('host')).toEqual([])
  log.append('host', row(1)); log.append('host', row(2)); log.append('other', row(3))
  expect(log.list('host')).toEqual([row(1), row(2)])
  expect(fs.readFileSync(path.join(directory, 'host.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
  log.delete('host'); log.delete('host')
  expect(fs.existsSync(path.join(directory, 'host.jsonl'))).toBe(false)
  expect(log.list('other')).toEqual([row(3)])
})
it('keeps only the newest 2000 rows on disk', () => {
  fs.writeFileSync(path.join(directory, 'host.jsonl'), Array.from({ length: 2000 }, (_, i) => JSON.stringify(row(i))).join('\n') + '\n')
  log.append('host', row(2000)); log.append('host', row(2001))
  expect(log.list('host')).toHaveLength(2000)
  expect(log.list('host')[0].at).toBe(2)
  expect(log.list('host').at(-1)?.at).toBe(2001)
  expect(fs.readFileSync(path.join(directory, 'host.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2000)
})
it('skips corrupt JSON and structurally invalid rows without losing healthy entries', () => {
  fs.writeFileSync(path.join(directory, 'host.jsonl'), [JSON.stringify(row(1)), '{broken', '{}', 'null', JSON.stringify(row(2))].join('\n'))
  expect(log.list('host')).toEqual([row(1), row(2)])
  log.append('host', row(3))
  expect(log.list('host')).toEqual([row(1), row(2), row(3)])
})
it('rejects paths outside the log directory', () => {
  for (const id of ['../escape', '/tmp/escape', '.', '']) {
    expect(() => log.append(id, row(1))).toThrow('标识')
    expect(() => log.list(id)).toThrow('标识')
    expect(() => log.delete(id)).toThrow('标识')
  }
})
