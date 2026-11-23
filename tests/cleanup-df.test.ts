import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { cleanupAvailableChange, cleanupDfCommand, parseCleanupDf } from '../src/core/cleanup/df'

const header = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
const row = (mount = '/', values = '1000 800 100 89%') => `${header}/dev/vda1 ${values} ${mount}\n`

describe('target mount df measurement', () => {
  it('builds a fixed read-only command with literal shell-safe operands and a stable locale', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-df-'))
    try {
      const marker = path.join(directory, 'must-not-exist')
      fs.writeFileSync(path.join(directory, 'df'), '#!/bin/sh\n[ "$LC_ALL" = C ] && [ "$#" = 3 ] && [ "$1" = -P ] && [ "$2" = -k ] || exit 99\nprintf "%s\\n" "$3"\n', { mode: 0o700 })
      for (const mount of ['/data files', "/data/' ; touch " + marker + '; #', '/data/$(touch ' + marker + ')', '/data/`touch ' + marker + '`']) {
        const command = cleanupDfCommand(mount)
        expect(command).toMatch(/^set -eu\nexport LC_ALL=C\ndf -P -k /)
        expect(execFileSync('/bin/sh', ['-c', command], { env: { ...process.env, PATH: directory, LC_ALL: 'broken' }, encoding: 'utf8' })).toBe(`${mount}\n`)
      }
      expect(fs.existsSync(marker)).toBe(false)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
  it.each(['', 'relative', '-P', '/bad\nname', '/bad\rname', '/bad\0name', '/' + 'x'.repeat(4096)])('rejects invalid operands: %j', (mount) => {
    expect(() => cleanupDfCommand(mount)).toThrow('cleanup.invalidMount')
    expect(parseCleanupDf(row(), mount)).toBeNull()
  })
  it('keeps the reported df capacity with reserved blocks rather than inventing a ratio', () => {
    expect(parseCleanupDf(row(), '/')).toEqual({ filesystem: '/dev/vda1', mountpoint: '/', totalBytes: 1024000, usedBytes: 819200, availableBytes: 102400, usagePercent: 89 })
    expect(parseCleanupDf(row().replace('1024-blocks', '1K-blocks').replace('Capacity', 'Use%'), '/')).toMatchObject({ usagePercent: 89 })
    expect(parseCleanupDf(row().replaceAll('\n', '\r\n'), '/')).toMatchObject({ availableBytes: 102400 })
  })
  it('matches literal and escaped whitespace without confusing a literal octal-looking path', () => {
    expect(parseCleanupDf(row('/data files'), '/data files')?.mountpoint).toBe('/data files')
    expect(parseCleanupDf(row('/data\\040files'), '/data files')?.mountpoint).toBe('/data files')
    expect(parseCleanupDf(row('/data\\011files'), '/data\tfiles')?.mountpoint).toBe('/data\tfiles')
    expect(parseCleanupDf(row('/data\\040files'), '/data\\040files')?.mountpoint).toBe('/data\\040files')
    expect(parseCleanupDf(row('/data\\134040files'), '/data\\040files')?.mountpoint).toBe('/data\\040files')
    expect(parseCleanupDf(row('/data '), '/data ')?.mountpoint).toBe('/data ')
  })
  it('does not accidentally measure a parent filesystem or accept extra output', () => {
    expect(parseCleanupDf(row('/'), '/data')).toBeNull()
    expect(parseCleanupDf(header, '/')).toBeNull()
    expect(parseCleanupDf(row().trimEnd(), '/')).toBeNull()
    expect(parseCleanupDf(row() + '/dev/vdb1 100 10 90 10% /data\n', '/')).toBeNull()
    expect(parseCleanupDf('banner\n' + row(), '/')).toBeNull()
    expect(parseCleanupDf(row().replace('1024-blocks', '512-blocks'), '/')).toBeNull()
    expect(parseCleanupDf(row().replace('1000', '1e3'), '/')).toBeNull()
  })
  it.each([
    '0 0 0 0%', '1000 800 -1 101%', '1000 800 100 101%', '1000 1001 0 100%',
    '1000 1 1001 1%', '1000 800 800 50%', '9007199254740992 1 1 50%', '8796093022208 1 1 50%',
    '1000 800 100 -1%', '1000 800 100 -', '1000 800 100 NaN%', '1000 8.5 100 89%'
  ])('treats unsupported or unsafe counters as unknown: %s', (values) => {
    expect(parseCleanupDf(row('/', values), '/')).toBeNull()
  })
  it('preserves negative available-space changes and refuses incomparable snapshots', () => {
    const before = parseCleanupDf(row('/', '1000 800 100 89%'), '/')!
    const after = parseCleanupDf(row('/', '1000 850 50 95%'), '/')!
    expect(cleanupAvailableChange(before, after)).toBe(-51200)
    expect(cleanupAvailableChange(after, before)).toBe(51200)
    expect(cleanupAvailableChange(before, before)).toBe(0)
    expect(cleanupAvailableChange(before, null)).toBeNull()
    expect(cleanupAvailableChange(null, after)).toBeNull()
    expect(cleanupAvailableChange(before, { ...after, mountpoint: '/data' })).toBeNull()
    expect(cleanupAvailableChange(before, { ...after, filesystem: '/dev/vdb1' })).toBeNull()
    expect(cleanupAvailableChange(before, { ...after, totalBytes: 2048000 })).toBeNull()
    expect(cleanupAvailableChange(before, { ...after, availableBytes: -1 })).toBeNull()
  })
})
