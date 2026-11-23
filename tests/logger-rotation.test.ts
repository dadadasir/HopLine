import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mock.dir } }))
import { logInfo, logWarn, logError } from '../src/main/logger'
let dir: string
beforeEach(() => {
  mock.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-logger-'))
  dir = path.join(mock.dir, 'logs'); fs.mkdirSync(dir)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(mock.dir, { recursive: true, force: true }) })
it('rotates an oversized file and shifts only three histories before continuing to write', () => {
  fs.writeFileSync(path.join(dir, 'hopline.log'), 'x'.repeat(1024 * 1024 + 1))
  for (let n = 1; n <= 3; n++) fs.writeFileSync(path.join(dir, `hopline.${n}.log`), `history-${n}`)
  logWarn('after rotation'); logInfo('continues'); logError('error', new Error('detail'))
  expect(fs.readdirSync(dir).sort()).toEqual(['hopline.1.log', 'hopline.2.log', 'hopline.3.log', 'hopline.log'])
  expect(fs.readFileSync(path.join(dir, 'hopline.1.log'), 'utf8')).toBe('x'.repeat(1024 * 1024 + 1))
  expect(fs.readFileSync(path.join(dir, 'hopline.2.log'), 'utf8')).toBe('history-1')
  expect(fs.readFileSync(path.join(dir, 'hopline.3.log'), 'utf8')).toBe('history-2')
  expect(fs.readFileSync(path.join(dir, 'hopline.log'), 'utf8')).toMatch(/warn after rotation\n.*info continues\n.*error error: detail\n/)
})
it('rotates during the same run using UTF-8 byte size', () => {
  logInfo('一'.repeat(180_000)); logInfo('二'.repeat(180_000)); logInfo('three')
  expect(fs.readFileSync(path.join(dir, 'hopline.1.log'), 'utf8')).toContain('一')
  const current = fs.readFileSync(path.join(dir, 'hopline.log'), 'utf8')
  expect(current).toContain('二'); expect(current).toContain('three'); expect(current).not.toContain('一')
})
it('does not propagate filesystem errors', () => {
  vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('disk full') })
  expect(() => logInfo('still safe')).not.toThrow()
})
