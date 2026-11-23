import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { shellEscape } from '../src/core/shell'
import { cleanupDuCommand, cleanupDuOutput, cleanupRunbook, parseCleanup } from '../src/core/runbook/cleanup'

// All executables are explicit fixtures. In particular, no command in these
// tests can reach the host Docker daemon, package managers or system log paths.
const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })))
const step = (id: string) => cleanupRunbook.steps.find((item) => item.id === id)!
interface FixtureConfig {
  now?: number
  root?: string
  containers?: { id: string; image?: string; driver?: string }[]
  images?: { id: string; size: number; created: string }[]
}
const shellTools = (() => {
  const names = ['sh', 'awk', 'find', 'sort', 'tail', 'grep', 'sed', 'true']
  const lines = execFileSync('/usr/bin/which', names, { encoding: 'utf8' }).trim().split('\n')
  return Object.fromEntries(names.map((name, index) => [name, lines[index]!]))
})()
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-portability-')); directories.push(directory)
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin)
  const target = (name: string) => path.join(directory, name)
  const file = (name: string, contents: string | Buffer) => { const filename = target(name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, contents); return filename }
  const shell = (name: string, source: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n{ printf '%s\\000' ${shellEscape(name)} "$@"; printf '\\n'; } >> ${shellEscape(target('calls.bin'))}\n${source}\n`, { mode: 0o700 })
  const print = (value: string | number) => `printf '%s\\n' ${shellEscape(String(value))}`
  for (const [name, executable] of Object.entries(shellTools)) fs.symlinkSync(executable, path.join(bin, name))
  file('calls.bin', ''); file('os-release', 'ID=debian\n')
  shell('id', 'printf 0')
  shell('nice', 'test "$1" = -n && test "$2" = 19 || exit 91; shift 2; exec "$@"')
  // Generate POSIX shell responses in the test process. Starting a Node runtime
  // for every docker/date/stat call makes a short script deadline depend on suite load.
  const configure = (config: FixtureConfig) => {
    shell('date', `[ "$#" = 1 ] && [ "$1" = '+%s' ] || exit 91\n${print(config.now ?? '')}`)
    shell('docker', `case "$1 \${2-}" in
  'info ') exit 0 ;;
  'info --format') case "$3" in '{{.DockerRootDir}}') ${print(config.root ?? '')} ;; *) ${print('json-file')} ;; esac ;;
  'container ls') ${print((config.containers ?? []).map(c => c.id).join('\n'))} ;;
  'container inspect')
    [ "$3" = --format ] || exit 91
    format=$4; shift 4
    for id do
      case "$id" in
        ${(config.containers ?? []).map(c => `${shellEscape(c.id)}) if [ "$format" = '{{.Image}}' ]; then ${print(c.image ?? '')}; else ${print(`${c.id} ${c.driver ?? ''}`)}; fi ;;`).join('\n        ')}
        *) exit 92 ;;
      esac
    done ;;
  'image ls') ${print((config.images ?? []).map(i => i.id).join('\n'))} ;;
  'image inspect')
    [ "$#" = 5 ] && [ "$3" = --format ] || exit 91
    case "$5" in
      ${(config.images ?? []).map(i => `${shellEscape(i.id)}) ${print(`${i.id} ${i.size} ${i.created}`)} ;;`).join('\n      ')}
      *) exit 92 ;;
    esac ;;
  *) exit 93 ;;
esac`)
  }
  // GNU stat/readlink syntax is emulated from THIS fixture's filesystem only.
  // Refresh before each run, so separate check/apply/verify calls see real sizes.
  const filesystemShims = () => {
    const entries = new Map<string, { size: number; device: number; inode: number; canonical: string }>()
    const visit = (filename: string) => {
      const info = fs.statSync(filename), canonical = fs.realpathSync(filename)
      const entry = { size: info.size, device: info.dev, inode: info.ino, canonical }
      entries.set(filename, entry); entries.set(canonical, entry)
      if (fs.lstatSync(filename).isDirectory()) for (const name of fs.readdirSync(filename)) visit(path.join(filename, name))
    }
    visit(directory)
    shell('readlink', `[ "$#" = 2 ] && [ "$1" = -f ] || exit 91\ncase "$2" in\n${[...entries].map(([name, entry]) => `${shellEscape(name)}) ${print(entry.canonical)} ;;`).join('\n')}\n*) exit 1 ;;\nesac`)
    shell('stat', `[ "$1" = -c ] || exit 91\nformat=$2; shift 2\nfor name do\ncase "$format:$name" in\n${[...entries].flatMap(([name, entry]) => Object.entries({ '%s': entry.size, '%d': entry.device, '%d:%i': `${entry.device}:${entry.inode}` }).map(([format, value]) => `${shellEscape(`${format}:${name}`)}) ${print(value)} ;;`)).join('\n')}\n*) exit 91 ;;\nesac\ndone`)
  }
  configure({})
  const run = (script: string) => {
    filesystemShims()
    const result = spawnSync('/bin/sh', ['-c', script.replaceAll('/etc/os-release', target('os-release'))], { encoding: 'utf8', env: { PATH: bin }, timeout: 15_000 })
    if (result.error) {
      // Capture before afterEach removes the isolated fixture; keep the same deadline.
      const diagnostic = {
        code: (result.error as NodeJS.ErrnoException).code, status: result.status, signal: result.signal,
        stdout: result.stdout?.slice(-4096), stderr: result.stderr?.slice(-4096),
        calls: fs.readFileSync(target('calls.bin'), 'utf8').slice(-8192).replaceAll('\0', ' | ')
      }
      throw new Error(`${result.error.message}\ncleanup fixture diagnostic: ${JSON.stringify(diagnostic)}`, { cause: result.error })
    }
    return result
  }
  const calls = () => fs.readFileSync(target('calls.bin'), 'utf8').split('\n').filter(Boolean).map((line) => {
    const [tool, ...args] = line.split('\0'); args.pop()
    return { tool, args }
  })
  return { directory, bin, target, file, shell, configure, run, calls }
}

it('measures only old unused images without date -d, including RFC3339 offsets and the exact seven-day boundary', () => {
  const f = fixture(), now = Date.parse('2026-11-11T12:00:00Z') / 1000
  f.configure({ now, containers: [{ id: 'container', image: 'used' }], images: [
    { id: 'old', size: 11, created: '2026-11-03T12:00:00.123456789Z' },
    { id: 'used', size: 13, created: '2026-11-01T12:00:00Z' },
    { id: 'boundary', size: 17, created: '2026-11-04T12:00:00Z' },
    { id: 'offset', size: 19, created: '2026-11-03T20:00:00+08:00' },
    { id: 'recent', size: 23, created: '2026-11-11T01:00:00-08:00' }
  ] })
  const result = f.run(step('docker-unused-images').check)
  expect(result.status, result.stderr).toBe(10)
  expect(parseCleanup(result.stdout).bytes).toBe(30)
  expect(f.calls().filter(c => c.tool === 'date').map(c => c.args)).toEqual([['+%s']])
})
it.each(['2026-02-29T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+99:00', 'not-a-time'])('rejects invalid image timestamp %s without a guessed size', (created) => {
  const f = fixture()
  f.configure({ now: Date.parse('2026-11-11T00:00:00Z') / 1000, images: [{ id: 'old', size: 42, created }] })
  const result = f.run(step('docker-unused-images').check)
  expect(result.status, result.stderr).toBe(20)
  expect(parseCleanup(result.stdout).bytes).toBeNull()
})
it('accepts a Gregorian leap day', () => {
  const f = fixture()
  f.configure({ now: Date.parse('2026-11-11T00:00:00Z') / 1000, images: [{ id: 'old', size: 42, created: '2024-02-29T00:00:00Z' }] })
  expect(parseCleanup(f.run(step('docker-unused-images').check).stdout).bytes).toBe(42)
})
it.each(['ID=rocky', 'ID=almalinux', 'ID=amzn', 'ID=custom\nID_LIKE="rhel fedora"'])('recognizes RPM distribution %s before measuring the configured cache', (release) => {
  const f = fixture(); f.file('os-release', `${release}\n`)
  f.file('rpm/repo/packages/pkg.rpm', Buffer.alloc(73)); f.file('rpm/repo/packages/metadata.txt', 'do not count')
  f.shell('dnf', '[ "$*" = "clean packages" ] || exit 94')
  const script = step('dnf-cache').check.replaceAll('/var/cache/dnf', f.target('rpm'))
  const result = f.run(script)
  expect(result.status, result.stderr).toBe(10)
  expect(parseCleanup(result.stdout).bytes).toBe(73)
  expect(f.run(step('dnf-cache').apply.replaceAll('/var/cache/dnf', f.target('rpm'))).status).toBe(0)
  expect(f.calls().filter(c => c.tool === 'dnf').map(c => c.args)).toEqual([['clean', 'packages']])
})
it('uses yum when dnf is absent and reports an unknown distribution as unsupported', () => {
  const f = fixture(); f.file('os-release', 'ID=amzn\nID_LIKE="centos rhel fedora"\n')
  f.file('yum/repo/packages/pkg.rpm', Buffer.alloc(91))
  f.shell('yum', '[ "$*" = "clean packages" ] || exit 94')
  const definition = step('dnf-cache'), script = definition.check.replaceAll('/var/cache/yum', f.target('yum'))
  expect(parseCleanup(f.run(script).stdout).bytes).toBe(91)
  expect(f.run(definition.apply).status).toBe(0)
  expect(f.calls().filter(c => c.tool === 'yum').map(c => c.args)).toEqual([['clean', 'packages']])
  f.file('os-release', 'ID=not-supported\n')
  const unsupported = f.run(script)
  expect(unsupported.status).toBe(30)
  expect(unsupported.stdout.trim()).toBe('cleanup.unsupported')
  expect(parseCleanup(unsupported.stdout).bytes).toBeNull()
})
it.each([true, false])('runs du at low priority, preserves -x, and handles depth support=%s', (depth) => {
  const f = fixture()
  f.shell('du', `case "$*" in *'/dev/null'*) exit ${depth ? 0 : 1} ;; esac\n${depth ? ':' : 'case " $* " in *" -d "*) exit 91 ;; esac'}\nprintf '9\\t/data/a\\n3\\t/data/a/b/c\\n'`)
  f.shell('ionice', '[ "$1" = -c3 ] || exit 91; shift; exec "$@"')
  const result = f.run(cleanupDuCommand('/data'))
  expect(result.status, result.stderr).toBe(0)
  expect(cleanupDuOutput(result.stdout, '/data')).toBe('9\t/data/a')
  const du = f.calls().filter(c => c.tool === 'du').at(-1)!
  expect(du.args).toEqual(depth ? ['-k', '-x', '-d', '2', '/data'] : ['-k', '-x', '/data'])
  expect(f.calls().filter(c => c.tool === 'ionice').at(-1)?.args.slice(0, 4)).toEqual(['-c3', 'nice', '-n', '19'])
})
it('does not swallow du failures without ionice and keeps complete partial rows', () => {
  const f = fixture()
  f.shell('du', `case "$*" in *'/dev/null'*) exit 1 ;; esac\nprintf '8\\t/data/complete\\n99\\t/data/unfinished'; exit 2`)
  const result = f.run(cleanupDuCommand('/data'))
  expect(result.status).toBe(2)
  expect(cleanupDuOutput(result.stdout, '/data')).toBe('8\t/data/complete')
})
it('filters fallback depth relative to the selected mount, never a lexical path prefix', () => {
  const output = '1\t/data\n2\t/data/one\n3\t/data/one/two\n4\t/data/one/two/three\n5\t/database/one\n'
  expect(cleanupDuOutput(output, '/data/')).toBe('3\t/data/one/two\n2\t/data/one\n1\t/data')
})
