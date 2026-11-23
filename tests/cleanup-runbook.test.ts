import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { cleanupDefaults, cleanupDuCommand, cleanupDuOutput, cleanupExecution, cleanupRunbook, parseCleanup } from '../src/core/runbook/cleanup'
import { envCommand } from '../src/core/runbook/engine'
import { cleanupActual, cleanupDirectories, cleanupGroup, cleanupGroups, cleanupReleased, cleanupSelection, cleanupSize, cleanupTotal } from '../src/renderer/src/logic/cleanup'
import { translate } from '../src/renderer/src/i18n'
const step = (id: string) => cleanupRunbook.steps.find((step) => step.id === id)!

it('parses only a complete first-line safe integer and preserves readable details', () => {
  expect(parseCleanup('bytes=1234\r\nDocker: 2 images\r\n  cached layers\n')).toEqual({ bytes: 1234, details: 'Docker: 2 images\n  cached layers' })
  expect(parseCleanup('bytes=0\nempty')).toEqual({ bytes: 0, details: 'empty' })
  for (const output of ['', 'notice\nbytes=2', 'bytes=-1', 'bytes=1.2', 'bytes=Infinity', 'bytes=9007199254740992', 'bytes=2 junk']) expect(parseCleanup(output).bytes).toBeNull()
})
it('identifies log drivers without counting local or journald data as reclaimable bytes', () => {
  const result = parseCleanup('bytes=42\ndrivers=json-file=2 local=1 journald=3 other=0\n')
  expect(result.bytes).toBe(42)
  expect(result.logDrivers).toEqual({ jsonFile: 2, local: 1, journald: 3, other: 0 })
  expect(parseCleanup('bytes=0\ndrivers=json-file=0 local=1 journald=0 other=0').bytes).toBe(0)
  for (const counts of ['json-file=1 local=-1 journald=0 other=0', 'json-file=1 local=1', 'json-file=1 local=1.5 journald=0 other=0', 'json-file=1 local=9007199254740992 journald=0 other=0', 'json-file=9007199254740991 local=1 journald=0 other=0', 'json-file=0 local=1 journald=0 other=0\ndrivers=json-file=0 local=1 journald=0 other=0']) {
    const invalid = parseCleanup(`bytes=42\ndrivers=${counts}\n`)
    expect(invalid.bytes).toBeNull(); expect(invalid.logDrivers).toBeUndefined()
  }
  for (const driver of ['jsonFile', 'local', 'journald', 'other']) for (const locale of ['zh', 'en'] as const) {
    const key = `cleanup.driver.${driver}`
    expect(translate(locale, key, { count: 2 })).not.toBe(key)
  }
})
it('has exactly the table defaults, no rollback, and conservative script guards', () => {
  expect(cleanupDefaults).toEqual(['docker-build-cache', 'docker-dangling-images', 'journal', 'apt-cache', 'dnf-cache', 'apk-cache', 'crash-reports', 'coredumps'])
  expect(cleanupRunbook.steps.every((step) => !step.rollback)).toBe(true)
  expect(step('old-kernels').check).toContain('uname -r')
  expect(step('old-kernels').check).toContain('*"$running"*|*"$latest"*) exit 20')
  expect(step('old-kernels').apply).toContain('apt-get -s autoremove --purge')
  expect(step('old-kernels').apply).toContain('apt-get autoremove --purge -y')
  for (const script of [step('tmp-old').check, step('tmp-old').apply]) {
    expect(script).toContain('find /tmp -xdev -type f -mtime +7')
    expect(script).toContain('lsof'); expect(script).toContain('fuser')
    expect(script).not.toContain('-type s')
    expect(script).toContain('stat -c')
  }
  expect(step('docker-container-logs').apply).toContain('truncate -s 0')
  expect(step('docker-container-logs').apply).not.toMatch(/\brm\b/)
  expect(step('docker-unused-images').check).toContain('docker container ls -aq')
  expect(step('docker-unused-images').check).toContain('604800')
  expect(step('docker-unused-images').apply).toContain('--filter until=168h')
  expect(step('journal').check).toContain('209715200')
})
it.each(cleanupRunbook.steps)('$id scripts have valid shell syntax without executing them', (definition) => {
  for (const script of [definition.check, definition.apply, definition.verify]) expect(() => execFileSync('/bin/sh', ['-n'], { input: script })).not.toThrow()
  // Also parse the quoted inner check; sh -n does not inspect sh -c arguments.
  expect(() => execFileSync('/bin/sh', ['-c', 'id() { echo 0; }; sh() { command /bin/sh -n -c "$2"; }; ' + definition.check])).not.toThrow()
})
it('selects only known, supported needed defaults; totals do not double count selected IDs', () => {
  const estimates = Object.fromEntries(cleanupRunbook.steps.map((step) => [step.id, { bytes: 300, details: '' }]))
  estimates['apk-cache'].bytes = 0
  const plan = { id: 'plan', sudo: 'root' as const, cleanup: estimates, steps: cleanupRunbook.steps.map((step) => ({ id: step.id, status: step.id === 'apk-cache' ? 'already' as const : 'needed' as const, reason: '', command: '' })) }
  expect(cleanupSelection(plan)).toEqual(cleanupDefaults.filter((id) => id !== 'apk-cache'))
  expect(cleanupSelection({ ...plan, cleanup: { ...estimates, journal: { bytes: null, details: '' }, 'apt-cache': { bytes: null, details: '', unavailable: true } } })).not.toContain('journal')
  expect(cleanupTotal(['journal', 'journal', 'missing'], estimates)).toBe(300)
  expect(cleanupReleased({ a: { before: 100, after: 30 }, b: { before: 10, after: 20 }, c: { before: 20, after: null } })).toBe(70)
  expect(cleanupSize(1024 ** 3)).toBe('1.0 GB')
})
it('quotes mount points, sorts and caps complete or partial du output, and rejects invalid input', () => {
  const command = cleanupDuCommand("/a'$(touch /tmp/oops)")
  expect(command).toContain("'/a'\\''$(touch /tmp/oops)'")
  expect(command).toContain('nice -n 19')
  expect(command).toContain('ionice -c3')
  expect(command).toContain('du -k -x')
  for (const mount of ['', 'relative', '/bad\0', '/bad\n', null]) expect(() => cleanupDuCommand(mount as string)).toThrow()
  expect(cleanupDuOutput('4\t/a\n16\t/b\nwarning\n8\t/c\npartial')).toBe('16\t/b\n8\t/c\n4\t/a')
  expect(cleanupDuOutput('8\t/complete\n100\t/trunca')).toBe('8\t/complete')
  expect(cleanupDuOutput(Array.from({ length: 30 }, (_, i) => `${i}\t/${i}`).join('\n')).split('\n')).toHaveLength(20)
})
it('has both translations for every item and risk', () => {
  for (const definition of cleanupRunbook.steps) for (const key of [definition.title, definition.description!]) for (const locale of ['zh', 'en'] as const) expect(translate(locale, key)).not.toBe(key)
})
describe('measurement adapter', () => {
  const definition = step('apt-cache')
  it.each([false, true])('compares the fresh pre-apply check to verify, including sudo wrapping=%s', async (sudo) => {
    const execute = vi.fn().mockResolvedValueOnce({ code: 10, stdout: 'bytes=100\ndetail', stderr: '' }).mockResolvedValueOnce({ code: 10, stdout: 'bytes=75\ndetail', stderr: '' }).mockResolvedValueOnce({ code: 10, stdout: 'bytes=25\ndetail', stderr: '' })
    const measured = cleanupExecution(execute)
    const call = (script: string) => measured.exec(sudo ? 'sudo wrapper' : script, { env: sudo ? { HL_SCRIPT: envCommand(script, {}) } : {} })
    expect((await call(definition.check)).code).toBe(10)
    expect(measured.estimates['apt-cache']).toMatchObject({ bytes: 100, details: 'detail' })
    await call(definition.check)
    expect((await call(definition.verify)).code).toBe(0)
    expect(measured.changes['apt-cache']).toEqual({ before: 75, after: 25 })
  })
  it.each([{ code: 0, stdout: 'missing' }, { code: 10, stdout: 'bytes=10', timedOut: true }, { code: 0, stdout: 'bytes=0', truncated: true }, { code: null, stdout: 'bytes=0', signal: 'TERM' }])('rejects uncertain results %j', async (result) => {
    const measured = cleanupExecution(vi.fn().mockResolvedValue({ stderr: '', ...result }))
    expect((await measured.exec(definition.check, { env: {} })).code).toBe(20)
    expect(measured.estimates['apt-cache'].bytes).toBeNull()
  })
  it('rejects unchanged/increasing verification; unsupported checks are distinguished from uncertainty', async () => {
    const execute = vi.fn().mockResolvedValue({ code: 10, stdout: 'bytes=100', stderr: '' }), measured = cleanupExecution(execute)
    await measured.exec(definition.check, { env: {} })
    expect((await measured.exec(definition.verify, { env: {} })).code).toBe(20)
    execute.mockResolvedValue({ code: 30, stdout: 'cleanup.unavailable', stderr: '' })
    expect((await measured.exec(definition.check, { env: {} })).code).toBe(10)
    expect(measured.estimates['apt-cache']).toMatchObject({ bytes: null, unavailable: true })
  })
})

it('ranks directory sizes without exposing raw du text or treating invalid bytes as zero', () => {
  expect(cleanupDirectories('4\t/data/small\n16\t/data/with space\n0\t/empty\nwarn\n-1\t/no\n9007199254740992\t/overflow')).toEqual([
    { path: '/data/with space', bytes: 16384 }, { path: '/data/small', bytes: 4096 }, { path: '/empty', bytes: 0 }
  ])
  expect(cleanupActual()).toBeNull()
  expect(cleanupActual({ before: 10, after: null })).toBeNull()
  expect(cleanupActual({ before: 10, after: 3 })).toBe(7)
  expect(cleanupActual({ before: 10, after: 20 })).toBe(0)
})
it('groups every existing item and translates descriptions and risk labels in both languages', () => {
  expect(cleanupGroup('docker-container-logs')).toBe('docker')
  expect(cleanupGroup('journal')).toBe('logs')
  expect(cleanupGroup('apt-cache')).toBe('packages')
  expect(cleanupGroup('old-kernels')).toBe('system')
  for (const locale of ['zh', 'en'] as const) for (const key of [
    ...cleanupRunbook.steps.map(step => `cleanup.description.${step.id}`),
    ...cleanupGroups.map(group => `cleanup.group.${group}`),
    ...['safe', 'low', 'medium'].map(risk => `cleanup.riskLabel.${risk}`),
    ...['root', 'nopass', 'password', 'missing', 'loading'].map(mode => `cleanup.sudo.${mode}`),
    ...['needed', 'already', 'unknown'].map(state => `cleanup.${state}`)
  ]) expect(translate(locale, key)).not.toBe(key)
})
