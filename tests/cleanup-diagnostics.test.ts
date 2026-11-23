import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CLEANUP_DIAGNOSTICS_SCRIPT, parseCleanupDiagnostics } from '../src/core/cleanup/diagnostics'
import { shellEscape } from '../src/core/shell'
import { startMiniSshd } from './support/mini-sshd.mjs'
import { connectEndpoint } from '../src/main/ssh/connect'
import { execOnClient } from '../src/main/ssh/exec'

const block = (name: string, body: string) => `===HOPLINE-CLEANUP:${name}===\n${body}\n#HOPLINE-END\n`
const lsofFile = (inode: string, bytes: number, fd = '3') => `f${fd}\ntREG\nD0x801\ni${inode}\ns${bytes}`
const inodeRows = 'Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/vda1 1000 900 100 90% /\n/dev/vdb1 2000 100 1900 5% /data space'
const logRow = (file: string, bytes: number) => `${bytes} ${Buffer.from(file).toString('hex')}`

it('deduplicates repeated descriptors and shared inodes in the total while preserving process owners', () => {
  const output = block('deleted', `#HOPLINE-SOURCE lsof\np42\ncworker\n${lsofFile('7', 100)}\n${lsofFile('7', 100, '4')}\np52\ncservice\n${lsofFile('7', 100)}\n${lsofFile('8', 20)}`)
  expect(parseCleanupDiagnostics(output).deleted).toEqual({ status: 'available', data: { totalBytes: 120, files: [
    { pid: 42, process: 'worker', bytes: 100 }, { pid: 52, process: 'service', bytes: 100 }, { pid: 52, process: 'service', bytes: 20 }
  ] } })
})

it('parses inode mounts, exact byte sizes, the largest logs and only the agreed rotation suffixes', () => {
  const names = ['app.log', 'app.log.gz', 'app.log.1', 'app.log.old', 'app.log.10', '应用 日志.log']
  const result = parseCleanupDiagnostics(block('inodes', inodeRows) + block('logs', names.map((name, i) => logRow(`/var/log/${name}`, i * 100)).join('\n')))
  expect(result.inodes).toEqual({ status: 'available', data: [
    { mountpoint: '/', total: 1000, used: 900, usagePercent: 90 }, { mountpoint: '/data space', total: 2000, used: 100, usagePercent: 5 }
  ] })
  expect(result.logs).toEqual({ status: 'available', data: names.map((name, i) => ({ path: `/var/log/${name}`, bytes: i * 100, rotated: [1, 2, 3].includes(i) })).reverse() })
  expect(parseCleanupDiagnostics(block('logs', Array.from({ length: 30 }, (_, i) => logRow(`/var/log/${i}`, i)).join('\n'))).logs).toMatchObject({ data: Array.from({ length: 12 }, (_, i) => ({ bytes: 29 - i })) })
})

it('distinguishes a complete empty result from missing, truncated, unsupported and failed data', () => {
  expect(parseCleanupDiagnostics(block('deleted', '#HOPLINE-SOURCE lsof')).deleted).toEqual({ status: 'available', data: { files: [], totalBytes: 0 } })
  expect(parseCleanupDiagnostics(block('logs', '')).logs).toEqual({ status: 'available', data: [] })
  expect(parseCleanupDiagnostics('').deleted).toMatchObject({ status: 'unavailable', reason: 'cleanup.diagnostic.missingSection' })
  expect(parseCleanupDiagnostics('===HOPLINE-CLEANUP:logs===\n').logs).toMatchObject({ status: 'unavailable', reason: 'cleanup.diagnostic.truncated' })
  expect(parseCleanupDiagnostics(block('logs', '#HOPLINE-UNAVAILABLE toolsMissing')).logs).toMatchObject({ status: 'unavailable', reason: 'cleanup.diagnostic.toolsMissing' })
  expect(parseCleanupDiagnostics(block('inodes', 'Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/vda1 - - - - /')).inodes).toMatchObject({ status: 'unavailable', reason: 'cleanup.diagnostic.inodeUnsupported' })
})

it('keeps valid high-inode mounts when another filesystem does not support inode counts', () => {
  expect(parseCleanupDiagnostics(block('inodes', `${inodeRows}\n/dev/vdc1 0 0 0 - /btrfs\nnone - - - - /virtual`)).inodes).toMatchObject({
    status: 'available', data: [{ mountpoint: '/', usagePercent: 90 }, { mountpoint: '/data space', usagePercent: 5 }], unavailableMounts: ['/btrfs', '/virtual']
  })
})

it('accepts large inode identities without rounding and fields in any order after the descriptor', () => {
  expect(parseCleanupDiagnostics(block('deleted', '#HOPLINE-SOURCE lsof\np42\ncworker\nf3\ns10\ni18446744073709551615\nD0x801\ntREG')).deleted).toEqual({
    status: 'available', data: { files: [{ pid: 42, process: 'worker', bytes: 10 }], totalBytes: 10 }
  })
})

it.each([
  block('deleted', `#HOPLINE-SOURCE lsof\np42\ncworker\n${lsofFile('1', 100)}\n${lsofFile('1', 101)}`),
  block('deleted', '#HOPLINE-SOURCE lsof\np42\ncworker\nf3\ntREG\ni1\ns10'),
  block('deleted', '#HOPLINE-SOURCE lsof\np42\ncworker\nf3\ntREG\nD0x1\ni1\ns9007199254740992'),
  block('deleted', '#HOPLINE-SOURCE proc\n42\t1 1 10\tworker\n42\t1 1 11\tworker'),
  block('deleted', '#HOPLINE-SOURCE lsof\nlsof: WARNING: cannot stat() inaccessible filesystem'),
  block('logs', '10 garbage'),
  block('logs', logRow('/var/log/forged\n#HOPLINE-END', 10)),
  block('logs', '') + block('logs', '')
])('rejects malformed or incomplete evidence instead of guessing a number (%#)', (output) => {
  const result = parseCleanupDiagnostics(output)
  expect(output.includes(':deleted') ? result.deleted : result.logs).toMatchObject({ status: 'unavailable', reason: 'cleanup.diagnostic.invalidData' })
})

let directory: string
const write = (relative: string, contents: string | Buffer) => {
  const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); return file
}
const command = (name: string, body: string) => fs.chmodSync(write(`bin/${name}`, `#!/bin/sh\n${body}\n`), 0o700)
const isolated = () => CLEANUP_DIAGNOSTICS_SCRIPT.replaceAll('/proc/', `${directory}/proc/`).replaceAll('/var/log', `${directory}/var/log`)
const execute = () => execFileSync('/bin/sh', ['-c', isolated()], { encoding: 'utf8', env: { ...process.env, PATH: `${directory}/bin` }, timeout: 10_000 })
const toolPaths = new Map<string, string>()
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-cleanup-diagnostic-'))
  fs.mkdirSync(path.join(directory, 'bin'))
  for (const name of ['sh', 'tr', 'cat', 'readlink', 'find', 'od', 'sort', 'awk']) {
    const location = toolPaths.get(name) ?? execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
    toolPaths.set(name, location)
    fs.symlinkSync(location, path.join(directory, 'bin', name))
  }
  command('id', 'printf "0\\n"')
  command('df', `printf '%s\\n' ${shellEscape(inodeRows)}`)
  command('lsof', `printf '%s\\n' ${shellEscape(`p42\ncworker\n${lsofFile('3', 4096)}`)}`)
  // Native stat avoids a Node startup for every file. Keep the GNU-format
  // interface and the temporary-path boundary on both macOS and Linux.
  command('stat', `
    [ "$#" -eq 3 ] || exit 90
    base=${shellEscape(directory)}; file=$3
    case "$file" in "$base"/*) ;; *) exit 90 ;; esac
    case "$file" in */../*) exit 90 ;; esac
    case "$1:$2" in
      '-Lc:%d %i %s') ${process.platform === 'darwin' ? 'exec /usr/bin/stat -L -f \'%d %i %z\' "$file"' : 'exec /usr/bin/stat -Lc \'%d %i %s\' -- "$file"'} ;;
      '-c:%s') ${process.platform === 'darwin' ? 'exec /usr/bin/stat -f %z "$file"' : 'exec /usr/bin/stat -c %s -- "$file"'} ;;
      *) exit 90 ;;
    esac
  `)
  write('var/log/application.log', Buffer.alloc(64))
  write('var/log/archived file.log.1', Buffer.alloc(128))
  write('var/log/应用.log.gz', Buffer.alloc(96))
  write('proc/1/comm', 'init\n'); fs.mkdirSync(path.join(directory, 'proc/1/fd'))
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

it('is POSIX-valid, runs all three read-only sections and safely handles spaces and Unicode paths', () => {
  execFileSync('/bin/sh', ['-n'], { input: CLEANUP_DIAGNOSTICS_SCRIPT })
  const result = parseCleanupDiagnostics(execute())
  expect(result.deleted).toEqual({ status: 'available', data: { files: [{ pid: 42, process: 'worker', bytes: 4096 }], totalBytes: 4096 } })
  expect(result.inodes).toMatchObject({ status: 'available' })
  expect(result.logs).toEqual({ status: 'available', data: [
    { path: path.join(directory, 'var/log/archived file.log.1'), bytes: 128, rotated: true },
    { path: path.join(directory, 'var/log/应用.log.gz'), bytes: 96, rotated: true },
    { path: path.join(directory, 'var/log/application.log'), bytes: 64, rotated: false }
  ] })
  expect(fs.statSync(path.join(directory, 'var/log/application.log')).size).toBe(64)
})

it('accepts lsof no-match exit status but reports permissions and missing tools independently', () => {
  command('lsof', 'exit 1')
  expect(parseCleanupDiagnostics(execute()).deleted).toMatchObject({ status: 'available', data: { totalBytes: 0 } })
  command('lsof', 'echo "Permission denied" >&2; exit 1')
  fs.rmSync(path.join(directory, 'bin/df'))
  const result = parseCleanupDiagnostics(execute())
  expect(result.deleted).toMatchObject({ status: 'unavailable', reason: 'cleanup.diagnostic.permissionDenied' })
  expect(result.inodes).toMatchObject({ status: 'unavailable', reason: 'cleanup.diagnostic.toolsMissing' })
  expect(result.logs).toMatchObject({ status: 'available' })
})

it('falls back to proc only without lsof and deduplicates descriptors before summing', () => {
  fs.rmSync(path.join(directory, 'bin/lsof'))
  write('proc/42/comm', 'worker\n'); fs.mkdirSync(path.join(directory, 'proc/42/fd'))
  const file = write('data/cache (deleted)', Buffer.alloc(512))
  fs.symlinkSync(file, path.join(directory, 'proc/42/fd/3'))
  fs.symlinkSync(file, path.join(directory, 'proc/42/fd/4'))
  expect(parseCleanupDiagnostics(execute()).deleted).toEqual({ status: 'available', data: { files: [{ pid: 42, process: 'worker', bytes: 512 }], totalBytes: 512 } })
  fs.rmSync(path.join(directory, 'proc'), { recursive: true })
  expect(parseCleanupDiagnostics(execute()).deleted).toMatchObject({ status: 'unavailable', reason: 'cleanup.diagnostic.procUnavailable' })
})

it('does not claim global deleted-file coverage without root', () => {
  command('id', 'printf "1000\\n"')
  expect(parseCleanupDiagnostics(execute()).deleted).toMatchObject({ status: 'unavailable', reason: 'cleanup.diagnostic.permissionDenied' })
})

it('runs the same read-only collector in one loopback SSH exec with no local host filesystem access', async () => {
  const server = await startMiniSshd({ username: 'cleanup-diagnostic', password: 'fixture-only' })
  const opened = await connectEndpoint({ host: '127.0.0.1', port: server.port, username: 'cleanup-diagnostic', auth: { authType: 'password', password: 'fixture-only', privateKey: null, privateKeyPath: null, passphrase: null } }, { verifyHost: async () => true, onKeyboard: async () => null })
  try {
    const result = await execOnClient(opened.client, `PATH=${shellEscape(path.join(directory, 'bin'))} sh -s`, { stdin: isolated() })
    expect(result.code).toBe(0)
    expect(result.stdout.match(/^#HOPLINE-END$/gm)).toHaveLength(3)
    expect(parseCleanupDiagnostics(result.stdout)).toMatchObject({ deleted: { status: 'available' }, inodes: { status: 'available' }, logs: { status: 'available' } })
  } finally { opened.client.end(); await server.close() }
})
