import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanupDefaults, cleanupRunbook, parseCleanup } from '../src/core/runbook/cleanup'
import { cleanupFileTargets } from '../src/core/runbook/cleanup-files'
import { shellEscape } from '../src/core/shell'
import { startMiniSshd } from './support/mini-sshd.mjs'
import { connectEndpoint } from '../src/main/ssh/connect'
import { execOnClient } from '../src/main/ssh/exec'

let directory: string
const write = (relative: string, contents: string | Buffer) => {
  const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); return file
}
const command = (name: string, body: string) => fs.chmodSync(write(`bin/${name}`, `#!/bin/sh\n${body}\n`), 0o700)
const step = (id: string) => cleanupRunbook.steps.find((item) => item.id === id)!
const rootOf = (id: string) => path.join(directory, cleanupFileTargets.find((item) => item.id === id)!.root.slice(1))
const isolated = (script: string) => cleanupFileTargets.reduce((result, item) => result.replaceAll(item.root, path.join(directory, item.root.slice(1))), script)
const execute = (id: string, phase: 'check' | 'apply' | 'verify', extra: Record<string, string> = {}) => {
  const result = spawnSync('/bin/sh', ['-c', isolated(step(id)[phase])], { encoding: 'utf8', env: { ...process.env, PATH: path.join(directory, 'bin'), ...extra }, timeout: 15_000 })
  if (result.error) throw result.error
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}
const events = (name: string): string[] => {
  try { return fs.readFileSync(path.join(directory, name), 'utf8').split('\0').filter(Boolean) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
const cleanupShellTools = (() => {
  const lines = execFileSync('/bin/sh', ['-c', 'command -v sh && command -v awk && command -v find'], { encoding: 'utf8' }).trim().split('\n')
  return { sh: lines[0]!, awk: lines[1]!, find: lines[2]! }
})()
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-cleanup-files-')))
  fs.mkdirSync(path.join(directory, 'bin'))
  for (const name of ['sh', 'awk'] as const) {
    fs.symlinkSync(cleanupShellTools[name], path.join(directory, 'bin', name))
  }
  const nativeFind = cleanupShellTools.find
  // BusyBox 1.36 only flushes pending -exec ... {} + at the expression's
  // top level. Reject nested actions before testing selection with native find;
  // this is a portability regression guard, not a real BusyBox execution.
  command('find', `
    depth=0
    for argument do
      case "$argument" in
        '(') depth=$((depth + 1)) ;;
        ')') depth=$((depth - 1)) ;;
        -exec) [ "$depth" -eq 0 ] || { echo 'nested batched action is unsupported' >&2; exit 90; } ;;
      esac
    done
    exec ${shellEscape(nativeFind)} "$@"
  `)
  command('id', 'echo 0')
  command('fuser', 'exit 1')
  const statCommand = process.platform === 'darwin'
    ? `/usr/bin/stat -f "$nativeFormat" "$file"`
    : `/usr/bin/stat -c "$nativeFormat" -- "$file"`
  const nativeFormats = process.platform === 'darwin'
    ? `case "$format" in %s) nativeFormat=%z ;; %d) nativeFormat=%d ;; '%d:%i') nativeFormat='%d:%i' ;; '%d:%i:%s:%Y') nativeFormat='%d:%i:%z:%m' ;; *) exit 90 ;; esac`
    : `case "$format" in %s|%d|'%d:%i'|'%d:%i:%s:%Y') nativeFormat=$format ;; *) exit 90 ;; esac`
  // These wrappers only touch the temporary tree. Native stat avoids starting a
  // Node runtime for each measurement while exercising the same GNU-format API.
  command('stat', `
    [ "$#" -eq 3 ] && [ "$1" = -c ] || exit 90
    format=$2; input=$3; base=${shellEscape(directory)}
    case "$input" in
      .) file=$PWD ;;
      ./*) name=\${input#./}; case "$name" in ''|.|..|*/*) exit 90 ;; esac; file="$PWD/$name" ;;
      *) exit 90 ;;
    esac
    case "$file" in "$base"|"$base"/*) ;; *) exit 90 ;; esac
    ${nativeFormats}
    value=$(${statCommand}) || exit 90
    if [ "\${FOREIGN_FILE:-}" = "$file" ]; then
      case "$format" in
        %d) value=$((value + 1)) ;;
        '%d:%i'|'%d:%i:%s:%Y') device=\${value%%:*}; value="$((device + 1)):\${value#*:}" ;;
      esac
    fi
    [ "$format" != %s ] || printf '%s\\000' "$file" >> "$base/measured.paths"
    printf '%s\\n' "$value"
  `)
  command('rm', `
    [ "$#" -eq 2 ] && [ "$1" = -- ] || exit 90
    base=${shellEscape(directory)}
    case "$2" in ./*) name=\${2#./} ;; *) exit 90 ;; esac
    case "$name" in ''|.|..|*/*) exit 90 ;; esac
    file="$PWD/$name"
    case "$file" in "$base"/*) ;; *) exit 90 ;; esac
    printf '%s\\000' "$file" >> "$base/removed.paths"
    [ -f "$file" ] && [ ! -L "$file" ] || exit 90
    exec /bin/rm -- "$file"
  `)
  for (const target of cleanupFileTargets) fs.mkdirSync(rootOf(target.id), { recursive: true })
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

it('only recommends crash reports and coredumps by default and keeps the three actions independent', () => {
  expect(cleanupDefaults).toContain('crash-reports')
  expect(cleanupDefaults).toContain('coredumps')
  expect(cleanupDefaults).not.toContain('rotated-logs')
  for (const target of cleanupFileTargets) {
    expect(step(target.id)?.sudo).toBe(true)
    execFileSync('/bin/sh', ['-n'], { input: step(target.id).check })
    execFileSync('/bin/sh', ['-n'], { input: step(target.id).apply })
  }
})

it('uses the same rotated-file selection for the estimate and deletion, excludes active logs and never enters journal', () => {
  const selected = [
    write('var/log/app.log.gz', Buffer.alloc(10)),
    write('var/log/app.log.1', Buffer.alloc(20)),
    write('var/log/nested/with space.old', Buffer.alloc(30)),
    write('var/log/nested/with\nnewline.gz', Buffer.alloc(40))
  ]
  const kept = [
    write('var/log/application.log', Buffer.alloc(50)),
    write('var/log/app.log.10', Buffer.alloc(60)),
    write('var/log/journal/archived.gz', Buffer.alloc(70)),
    write('var/log/journal/machine/archived.old', Buffer.alloc(80)),
    write('web/database.gz', Buffer.alloc(90))
  ]
  fs.symlinkSync(kept.at(-1)!, path.join(rootOf('rotated-logs'), 'linked.gz'))
  fs.symlinkSync(path.join(directory, 'web'), path.join(rootOf('rotated-logs'), 'linked-dir'))
  fs.mkdirSync(path.join(rootOf('rotated-logs'), 'directory.gz'))
  expect(execute('rotated-logs', 'check')).toMatchObject({ code: 10 })
  expect(parseCleanup(execute('rotated-logs', 'check').stdout).bytes).toBe(100)
  expect([...new Set(events('measured.paths'))].sort()).toEqual([...selected].sort())
  expect(execute('rotated-logs', 'apply')).toMatchObject({ code: 0 })
  expect(events('removed.paths').sort()).toEqual([...selected].sort())
  for (const file of kept) expect(fs.existsSync(file)).toBe(true)
  expect(fs.lstatSync(path.join(rootOf('rotated-logs'), 'linked.gz')).isSymbolicLink()).toBe(true)
  expect(fs.lstatSync(path.join(rootOf('rotated-logs'), 'linked-dir')).isSymbolicLink()).toBe(true)
  expect(fs.statSync(path.join(rootOf('rotated-logs'), 'directory.gz')).isDirectory()).toBe(true)
  expect(execute('rotated-logs', 'verify')).toMatchObject({ code: 0 })
  expect(parseCleanup(execute('rotated-logs', 'check').stdout).bytes).toBe(0)
})

it('preserves a rotated file still held by a process in both check and apply', () => {
  const busy = write('var/log/busy.gz', Buffer.alloc(50)), clear = write('var/log/clear.old', Buffer.alloc(20))
  command('fuser', 'case "$1" in ./busy.gz) echo 123; exit 0 ;; *) exit 1 ;; esac')
  expect(parseCleanup(execute('rotated-logs', 'check').stdout).bytes).toBe(20)
  expect(events('measured.paths')).toEqual([clear])
  expect(execute('rotated-logs', 'apply').code).toBe(0)
  expect(events('removed.paths')).toEqual([clear])
  expect(fs.statSync(busy).size).toBe(50)
  expect(parseCleanup(execute('rotated-logs', 'verify').stdout).bytes).toBe(0)
})

it('keeps a previously previewed log when a process opens it before apply', () => {
  const file = write('var/log/changed.gz', Buffer.alloc(50))
  expect(parseCleanup(execute('rotated-logs', 'check').stdout).bytes).toBe(50)
  command('fuser', 'echo 123; exit 0')
  expect(execute('rotated-logs', 'apply').code).toBe(0)
  expect(events('removed.paths')).toEqual([])
  expect(fs.statSync(file).size).toBe(50)
})

it('reports unknown and never deletes when occupancy tools are missing or fail', () => {
  const file = write('var/log/uncertain.gz', Buffer.alloc(50))
  fs.rmSync(path.join(directory, 'bin/fuser'))
  let result = execute('rotated-logs', 'check')
  expect(result.code).toBe(20); expect(parseCleanup(result.stdout).bytes).toBeNull()
  expect(execute('rotated-logs', 'apply').code).toBe(20)
  command('fuser', 'echo "Permission denied" >&2; exit 1')
  result = execute('rotated-logs', 'check')
  expect(result.code).toBe(20); expect(parseCleanup(result.stdout).bytes).toBeNull()
  expect(execute('rotated-logs', 'apply').code).toBe(20)
  expect(events('removed.paths')).toEqual([])
  expect(fs.statSync(file).size).toBe(50)
})

it('uses normal lsof as a conservative fallback and rejects BusyBox lsof', () => {
  const file = write('var/log/clear.gz', Buffer.alloc(50))
  fs.rmSync(path.join(directory, 'bin/fuser'))
  command('lsof', 'case "$1" in -v) echo "lsof version information"; exit 0 ;; -t) exit 1 ;; *) exit 90 ;; esac')
  expect(parseCleanup(execute('rotated-logs', 'check').stdout).bytes).toBe(50)
  command('lsof', 'case "$1" in -v) echo "BusyBox v1.36"; exit 0 ;; *) echo 123; exit 0 ;; esac')
  const result = execute('rotated-logs', 'check')
  expect(result.code).toBe(20); expect(parseCleanup(result.stdout).bytes).toBeNull()
  expect(execute('rotated-logs', 'apply').code).toBe(20)
  expect(fs.statSync(file).size).toBe(50)
  expect(events('removed.paths')).toEqual([])
  command('lsof', 'case "$1" in -v) echo "lsof version information"; exit 0 ;; -t) exit 1 ;; *) exit 90 ;; esac')
  expect(execute('rotated-logs', 'apply').code).toBe(0)
  expect(events('removed.paths')).toEqual([file])
})

it('uses ordinary lsof instead of trusting a BusyBox fuser no-match result', () => {
  const busy = write('var/log/busy.gz', Buffer.alloc(50)), clear = write('var/log/clear.old', Buffer.alloc(20))
  command('fuser', 'case "$1" in --help) echo "BusyBox v1.36"; exit 0 ;; *) exit 1 ;; esac')
  command('lsof', 'case "$1" in -v) echo "lsof version information"; exit 0 ;; -t) case "$3" in ./busy.gz) echo 123; exit 0 ;; *) exit 1 ;; esac ;; *) exit 90 ;; esac')
  expect(parseCleanup(execute('rotated-logs', 'check').stdout).bytes).toBe(20)
  expect(events('measured.paths')).toEqual([clear])
  expect(execute('rotated-logs', 'apply').code).toBe(0)
  expect(events('removed.paths')).toEqual([clear])
  expect(fs.statSync(busy).size).toBe(50)
})

it.each(['missing', 'busybox'] as const)('reports unknown when fuser is BusyBox and ordinary lsof is %s', (fallback) => {
  const file = write('var/log/uncertain.gz', Buffer.alloc(50))
  command('fuser', 'case "$1" in --help) echo "BusyBox v1.36"; exit 0 ;; *) exit 1 ;; esac')
  if (fallback === 'busybox') command('lsof', 'echo "BusyBox v1.36"; exit 1')
  const result = execute('rotated-logs', 'check')
  expect(result.code).toBe(20); expect(parseCleanup(result.stdout).bytes).toBeNull()
  expect(execute('rotated-logs', 'apply').code).toBe(20)
  expect(events('measured.paths')).toEqual([])
  expect(events('removed.paths')).toEqual([])
  expect(fs.statSync(file).size).toBe(50)
})

it.each(['crash-reports', 'coredumps'])('%s deletes ordinary files only, preserves directories and symlinks, then needs no second cleanup', (id) => {
  const root = rootOf(id), first = path.join(root, 'record'), second = path.join(root, 'nested', 'spaces and\nnewline')
  fs.writeFileSync(first, Buffer.alloc(17)); fs.mkdirSync(path.dirname(second)); fs.writeFileSync(second, Buffer.alloc(23))
  const protectedFile = write('web/database', Buffer.alloc(99))
  fs.symlinkSync(protectedFile, path.join(root, 'link'))
  fs.symlinkSync(path.join(directory, 'web'), path.join(root, 'linked-dir'))
  expect(parseCleanup(execute(id, 'check').stdout).bytes).toBe(40)
  expect(execute(id, 'apply')).toMatchObject({ code: 0 })
  expect(events('removed.paths').sort()).toEqual([first, second].sort())
  expect(fs.statSync(protectedFile).size).toBe(99)
  expect(fs.lstatSync(path.join(root, 'link')).isSymbolicLink()).toBe(true)
  expect(fs.existsSync(path.dirname(second))).toBe(true)
  expect(execute(id, 'verify')).toMatchObject({ code: 0 })
  expect(parseCleanup(execute(id, 'check').stdout).bytes).toBe(0)
})

it.each(['rotated-logs', 'crash-reports', 'coredumps'])('%s refuses a symlink root and leaves the external target intact', (id) => {
  const root = rootOf(id), protectedFile = write('website/data.gz', Buffer.alloc(123))
  fs.rmSync(root, { recursive: true }); fs.symlinkSync(path.dirname(protectedFile), root)
  for (const phase of ['check', 'apply'] as const) expect(execute(id, phase).code).toBe(20)
  expect(fs.statSync(protectedFile).size).toBe(123)
  expect(events('removed.paths')).toEqual([])
})

it('refuses an ancestor symlink even when the final cleanup directory itself is ordinary', () => {
  fs.rmSync(path.join(directory, 'var/lib'), { recursive: true })
  const protectedFile = write('website/systemd/coredump/database', Buffer.alloc(123))
  fs.symlinkSync(path.join(directory, 'website'), path.join(directory, 'var/lib'))
  expect(execute('coredumps', 'check').code).toBe(20)
  expect(execute('coredumps', 'apply').code).toBe(20)
  expect(fs.statSync(protectedFile).size).toBe(123)
  expect(events('removed.paths')).toEqual([])
})

it('rejects a cross-device candidate rather than measuring or deleting it', () => {
  const file = path.join(rootOf('crash-reports'), 'foreign'); fs.writeFileSync(file, Buffer.alloc(10))
  expect(execute('crash-reports', 'check', { FOREIGN_FILE: file }).code).toBe(20)
  expect(execute('crash-reports', 'apply', { FOREIGN_FILE: file }).code).toBe(20)
  expect(events('removed.paths')).toEqual([])
  expect(fs.statSync(file).size).toBe(10)
})

it.each(['check', 'apply'] as const)('rejects %s when find hides an earlier failed batch behind a successful final batch', (phase) => {
  const root = rootOf('crash-reports'), foreign = path.join(root, 'foreign'), clear = path.join(root, 'clear')
  fs.writeFileSync(foreign, Buffer.alloc(10)); fs.writeFileSync(clear, Buffer.alloc(20))
  // Model BusyBox's early batch status loss without downloading or running
  // BusyBox: execute both real action bodies, then deliberately return zero.
  command('find', `
    set -eu
    while [ "$#" -gt 0 ] && [ "$1" != -exec ]; do shift; done
    [ "$#" -gt 0 ] || exit 90
    shift
    [ "$1" = sh ] && [ "$2" = -c ] || exit 90
    action=$3; shift 3
    [ "$1" = sh ] || exit 90
    shift
    root=$1; expected=$2; device=$3
    first=0; sh -c "$action" sh "$root" "$expected" "$device" ./foreign || first=$?
    last=0; sh -c "$action" sh "$root" "$expected" "$device" ./clear || last=$?
    printf '%s:%s\\n' "$first" "$last" > ${shellEscape(path.join(directory, 'batch-statuses'))}
    exit 0
  `)
  const result = execute('crash-reports', phase, { FOREIGN_FILE: foreign })
  expect(fs.readFileSync(path.join(directory, 'batch-statuses'), 'utf8')).toBe('20:0\n')
  expect(result.code).toBe(20)
  if (phase === 'check') expect(parseCleanup(result.stdout).bytes).toBeNull()
  expect(fs.statSync(foreign).size).toBe(10)
  expect(events('removed.paths')).toEqual(phase === 'apply' ? [clear] : [])
})

it('treats an absent fixed directory as empty, but a regular file in its place as uncertain', () => {
  const root = rootOf('crash-reports'); fs.rmSync(root, { recursive: true })
  expect(parseCleanup(execute('crash-reports', 'check').stdout).bytes).toBe(0)
  expect(execute('crash-reports', 'apply').code).toBe(0)
  fs.writeFileSync(root, 'not a directory')
  const result = execute('crash-reports', 'check')
  expect(result.code).toBe(20); expect(parseCleanup(result.stdout).bytes).toBeNull()
  expect(execute('crash-reports', 'apply').code).toBe(20)
  expect(fs.readFileSync(root, 'utf8')).toBe('not a directory')
})

it('checks, removes and verifies the isolated fixed targets through loopback SSH', async () => {
  write('var/crash/crash report', Buffer.alloc(42))
  const server = await startMiniSshd({ username: 'cleanup-files', password: 'fixture-only' })
  const opened = await connectEndpoint({ host: '127.0.0.1', port: server.port, username: 'cleanup-files', auth: { authType: 'password', password: 'fixture-only', privateKey: null, privateKeyPath: null, passphrase: null } }, { verifyHost: async () => true, onKeyboard: async () => null })
  const remote = (phase: 'check' | 'apply' | 'verify') => execOnClient(opened.client, `PATH=${shellEscape(path.join(directory, 'bin'))} sh -c ${shellEscape(isolated(step('crash-reports')[phase]))}`)
  try {
    const before = await remote('check'); expect(before.code).toBe(10); expect(parseCleanup(before.stdout).bytes).toBe(42)
    expect((await remote('apply')).code).toBe(0)
    const after = await remote('verify'); expect(after.code).toBe(0); expect(parseCleanup(after.stdout).bytes).toBe(0)
    expect(fs.existsSync(path.join(rootOf('crash-reports'), 'crash report'))).toBe(false)
  } finally { opened.client.end(); await server.close() }
})
