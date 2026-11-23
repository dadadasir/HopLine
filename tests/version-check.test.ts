import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { checkVersion, compareVersions } from '../src/main/version-check'

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-version-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }) })
const save = (value: unknown) => fs.writeFileSync(path.join(directory, 'last-version.json'), JSON.stringify(value))
const read = () => JSON.parse(fs.readFileSync(path.join(directory, 'last-version.json'), 'utf8'))

it.each([
  ['0.2.0', '0.3.0', -1], ['0.10.0', '0.9.0', 1], ['1.0.0-beta.1', '1.0.0', -1],
  ['1.0.0-beta.2', '1.0.0-beta.10', -1], ['1.0.0-alpha', '1.0.0-alpha.1', -1],
  ['1.0.0-1', '1.0.0-alpha', -1], ['1.0.0-beta', '1.0.0-alpha', 1],
  ['1.0.0+build.2', '1.0.0+build.1', 0], ['1.0.0', '1.0.0', 0],
  ['1.0.0-beta.1', '1.0.0-beta.1', 0], ['1.0.0-beta', '1.0.0-beta.1', -1]
])('compares %s against %s', (left, right, order) => {
  expect(compareVersions(left, right)).toBe(order)
  expect(compareVersions(right, left)).toBe(order === 0 ? 0 : -order)
})

it.each(['', 'v1.0.0', '1.0', '01.0.0', '1.0.0-beta.01', '1.0.0-', '1.0.0+a..b', ' 1.0.0', '1.0.0\n'])('rejects invalid version %j', (version) => {
  expect(compareVersions(version, '1.0.0')).toBeNull()
  expect(compareVersions('1.0.0', version)).toBeNull()
  expect(checkVersion(directory, version)).toBeNull()
  expect(fs.readdirSync(directory)).toEqual([])
})

it('writes the first installation atomically without announcing it', () => {
  const rename = vi.spyOn(fs, 'renameSync')
  expect(checkVersion(directory, '0.2.0')).toBeNull()
  expect(read()).toEqual({ version: '0.2.0' })
  expect(rename).toHaveBeenCalledWith(path.join(directory, 'last-version.json.tmp'), path.join(directory, 'last-version.json'))
  expect(fs.readdirSync(directory)).toEqual(['last-version.json'])
})

it.each(['0.3.0', '1.0.0-beta.1', '1.0.0+build.7'])('does not rewrite unchanged version %s', (version) => {
  const file = path.join(directory, 'last-version.json')
  const contents = JSON.stringify({ version }, null, 2) + '\n'
  fs.writeFileSync(file, contents)
  const write = vi.spyOn(fs, 'writeFileSync')
  const sync = vi.spyOn(fs, 'fsyncSync')
  const rename = vi.spyOn(fs, 'renameSync')
  expect(checkVersion(directory, version)).toBeNull()
  expect(write).not.toHaveBeenCalled()
  expect(sync).not.toHaveBeenCalled()
  expect(rename).not.toHaveBeenCalled()
  expect(fs.readFileSync(file, 'utf8')).toBe(contents)
  expect(fs.readdirSync(directory)).toEqual(['last-version.json'])
})

it('records changed build metadata without announcing an upgrade', () => {
  save({ version: '1.0.0+build.1' })
  expect(checkVersion(directory, '1.0.0+build.2')).toBeNull()
  expect(read()).toEqual({ version: '1.0.0+build.2' })
})

it('announces an upgrade only once, including prerelease to stable', () => {
  save({ version: '0.2.0' })
  expect(checkVersion(directory, '0.3.0')).toEqual({ previous: '0.2.0', current: '0.3.0' })
  expect(checkVersion(directory, '0.3.0')).toBeNull()
  save({ version: '1.0.0-beta.1' })
  expect(checkVersion(directory, '1.0.0')).toEqual({ previous: '1.0.0-beta.1', current: '1.0.0' })
})

it('records a downgrade without announcing it', () => {
  save({ version: '0.3.0' })
  expect(checkVersion(directory, '0.2.0')).toBeNull()
  expect(read()).toEqual({ version: '0.2.0' })
})

it.each(['{broken', 'null', '[]', '{}', '{"version":12}', '{"version":"invalid"}'])('silently replaces corrupt history %s', (contents) => {
  fs.writeFileSync(path.join(directory, 'last-version.json'), contents)
  expect(checkVersion(directory, '0.3.0')).toBeNull()
  expect(read()).toEqual({ version: '0.3.0' })
})

it('suppresses notification on a failed atomic write and preserves the previous record', () => {
  save({ version: '0.2.0' })
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('read-only') })
  expect(checkVersion(directory, '0.3.0')).toBeNull()
  expect(read()).toEqual({ version: '0.2.0' })
})
