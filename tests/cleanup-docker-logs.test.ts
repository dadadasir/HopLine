import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { cleanupDockerLogScripts } from '../src/core/runbook/cleanup-docker-logs'
import { parseCleanup } from '../src/core/runbook/cleanup'
import { shellEscape } from '../src/core/shell'
import { startMiniSshd } from './support/mini-sshd.mjs'
import { connectEndpoint } from '../src/main/ssh/connect'
import { execOnClient } from '../src/main/ssh/exec'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })))
const id = (digit: string) => digit.repeat(64)
const identity = (file: string) => { const info = fs.statSync(file); return `${info.dev}:${info.ino}` }
const measure = `${cleanupDockerLogScripts.measure}\nprintf 'bytes=%s\\n' "$bytes"\n${cleanupDockerLogScripts.details}\n[ "$bytes" -eq 0 ] && exit 0\nexit 10`
const source = (phase: 'check' | 'apply') => phase === 'check' ? measure : cleanupDockerLogScripts.apply
interface Container { id: string; driver?: string; inspect?: string }
interface Configuration { root?: string; ids?: string; fail?: 'info' | 'list' | 'inspect' }

const dockerLogTools = (() => {
  const lines = execFileSync('/bin/sh', ['-c', 'command -v sh && command -v awk'], { encoding: 'utf8' }).trim().split('\n')
  return { sh: lines[0]!, awk: lines[1]! }
})()

/** Every executable and every mutation is confined to this temporary tree. */
function fixture(rootName = 'docker data') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-docker-logs-'))); directories.push(directory)
  const bin = path.join(directory, 'bin'), root = path.join(directory, rootName)
  fs.mkdirSync(bin); fs.mkdirSync(root, { recursive: true })
  const file = (relative: string, content: string | Buffer) => {
    const filename = path.join(directory, relative); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); return filename
  }
  const shell = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 })
  const print = (value: string) => `printf '%s\\n' ${shellEscape(value)}`
  const events = (name: string) => fs.existsSync(path.join(directory, name)) ? fs.readFileSync(path.join(directory, name), 'utf8').split('\0').filter(Boolean) : []
  const clearEvents = () => { for (const name of ['measured.ids', 'truncated.ids', 'truncate-attempts']) fs.rmSync(path.join(directory, name), { force: true }) }
  for (const [name, executable] of Object.entries(dockerLogTools)) fs.symlinkSync(executable, path.join(bin, name))
  const nativeStat = (format: string, filename: string, follow = false) => process.platform === 'darwin'
    ? `/usr/bin/stat ${follow ? '-L ' : ''}-f ${shellEscape(format.replaceAll('%s', '%z').replaceAll('%h', '%l'))} ${filename}`
    : `/usr/bin/stat ${follow ? '-L ' : ''}-c ${shellEscape(format)} -- ${filename}`
  // Darwin's /dev/fd entry has an fdescfs st_dev. With no pathname, native
  // stat uses fstat(stdin), preserving the opened file's real device/inode.
  const nativeFdStat = (format: string) => process.platform === 'darwin'
    ? `/usr/bin/stat -f ${shellEscape(format.replaceAll('%s', '%z').replaceAll('%h', '%l'))} <&3`
    : nativeStat(format, '/proc/self/fd/3', true)
  const selectedStat = (format: string, follow = false) => `if [ "$input" = /proc/self/fd/3 ]; then ${nativeFdStat(format)}; else ${nativeStat(format, '"$file"', follow)}; fi`
  const descriptor = process.platform === 'darwin' ? '/dev/fd/3' : '/proc/self/fd/3'
  shell('stat', `
    [ "$#" -eq 3 ] || exit 90
    option=$1; format=$2; input=$3; base=${shellEscape(directory)}
    case "$option" in (-c|-Lc) : ;; (*) exit 90 ;; esac
    case "$input" in
      (/proc/self/fd/3) file=${shellEscape(descriptor)} ;;
      (.) file=$(pwd -P) ;;
      (./*) file="$(pwd -P)/\${input#./}" ;;
      ("$base"/*) file=$input ;;
      (*) exit 90 ;;
    esac
    case "$format" in
      ('%d:%i') value=$(${selectedStat('%d:%i')}) ;;
      ('%d:%i:%h') value=$(${selectedStat('%d:%i:%h', true)}) ;;
      (%s) value=$(${selectedStat('%s', true)}) ;;
      (*) exit 90 ;;
    esac
    if [ "$file" = "\${FOREIGN_FILE:-}" ]; then
      case "$format" in ('%d:%i'|'%d:%i:%h') dev=\${value%%:*}; value="$((dev + 1)):\${value#*:}" ;; esac
    fi
    if [ "$input" = /proc/self/fd/3 ] && [ "$format" = %s ]; then
      opened=$(${nativeFdStat('%d:%i')})
      printf '%s\\000' "$opened" >> "$base/measured.ids"
      [ -z "\${BAD_SIZE:-}" ] || value=$BAD_SIZE
    fi
    if [ "$file" = "\${REPLACE_FILE:-}" ] && [ "$format" = '%d:%i:%h' ] && [ ! -e "$base/replaced" ]; then
      case "$REPLACE_FILE:$REPLACEMENT_TARGET" in ("$base"/*:"$base"/*) : ;; (*) exit 90 ;; esac
      /bin/mv "$REPLACE_FILE" "$REPLACE_FILE.saved"
      /bin/ln -s "$REPLACEMENT_TARGET" "$REPLACE_FILE"
      : > "$base/replaced"
    fi
    if [ "$input" = /proc/self/fd/3 ] && [ "$format" = '%d:%i:%h' ] && [ -n "\${REPLACE_PARENT:-}" ] && [ ! -e "$base/replaced" ]; then
      case "$REPLACE_PARENT:$REPLACEMENT_TARGET" in ("$base"/*:"$base"/*) : ;; (*) exit 90 ;; esac
      /bin/mv "$REPLACE_PARENT" "$REPLACE_PARENT.saved"
      /bin/ln -s "$REPLACEMENT_TARGET" "$REPLACE_PARENT"
      : > "$base/replaced"
    fi
    printf '%s\\n' "$value"
  `)
  const configure = (containers: Container[] = [], options: Configuration = {}) => {
    shell('docker', `
      case "$1 \${2-}" in
        ('info --format')
          [ "$#" -eq 3 ] && [ "$3" = '{{.DockerRootDir}}' ] || exit 90
          ${options.fail === 'info' ? 'exit 1' : print(options.root ?? root)} ;;
        ('container ls')
          [ "$#" -eq 4 ] && [ "$3" = -aq ] && [ "$4" = --no-trunc ] || exit 90
          ${options.fail === 'list' ? 'exit 1' : print(options.ids ?? containers.map(container => container.id).join('\n'))} ;;
        ('container inspect')
          [ "$#" -eq 5 ] && [ "$3" = --format ] && [ "$4" = '{{.Id}} {{.HostConfig.LogConfig.Type}}' ] || exit 90
          ${options.fail === 'inspect' ? 'exit 1' : `case "$5" in
            ${containers.map(container => `(${shellEscape(container.id)}) ${print(container.inspect ?? `${container.id} ${container.driver ?? ''}`)} ;;`).join('\n')}
            (*) exit 90 ;;
          esac`} ;;
        (*) exit 90 ;;
      esac
    `)
  }
  // Truncate's GNU/BusyBox API is replaced by an inode-checked POSIX shim.
  // Darwin lacks /proc, so fstat its inherited descriptor and match it to an
  // allowed fixture log. Never truncate a host or volume path in the fixture.
  const prepare = () => {
    const logs: string[] = [], containers = path.join(root, 'containers')
    if (fs.existsSync(containers) && !fs.lstatSync(containers).isSymbolicLink()) for (const container of fs.readdirSync(containers)) {
      const parent = path.join(containers, container), log = path.join(parent, `${container}-json.log`)
      if (/^[a-f0-9]{64}$/.test(container) && !fs.lstatSync(parent).isSymbolicLink() && fs.existsSync(log) && fs.lstatSync(log).isFile()) logs.push(log)
    }
    shell('truncate', `
      printf 'attempt\\000' >> ${shellEscape(path.join(directory, 'truncate-attempts'))}
      [ "$#" -eq 4 ] && [ "$1" = -s ] && [ "$2" = 0 ] && [ "$3" = -- ] && [ "$4" = /proc/self/fd/3 ] || exit 90
      opened=$(${nativeFdStat('%d:%i')})
      case "$opened" in
        ${logs.map(log => `(${shellEscape(identity(log))}) file=${shellEscape(log)} ;;`).join('\n')}
        (*) exit 90 ;;
      esac
      [ -f "$file" ] && [ ! -L "$file" ] && [ "$opened" = "$(${nativeStat('%d:%i', '"$file"', true)})" ] || exit 90
      : > "$file"
      printf '%s\\000' "$opened" >> ${shellEscape(path.join(directory, 'truncated.ids'))}
    `)
  }
  const run = (phase: 'check' | 'apply', extra: Record<string, string> = {}, sh = '/bin/sh') => {
    prepare()
    const result = spawnSync(sh, ['-c', source(phase)], { encoding: 'utf8', env: { PATH: bin, ...extra }, timeout: 15_000 })
    if (result.error) throw result.error
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  const json = (container: string, size: number) => file(`${rootName}/containers/${container}/${container}-json.log`, Buffer.alloc(size, 0x61))
  const remoteCommand = (phase: 'check' | 'apply') => { prepare(); return `PATH=${shellEscape(bin)} sh -c ${shellEscape(source(phase))}` }
  configure()
  return { directory, bin, root, file, shell, configure, prepare, run, events, clearEvents, json, remoteCommand }
}

it.each(['custom-docker', 'daemon data/with spaces'])('uses %s and only the fixed JSON log names across mixed drivers', (rootName) => {
  const f = fixture(rootName), first = f.json(id('a'), 11), second = f.json(id('b'), 29)
  const local = f.json(id('c'), 31), journal = f.json(id('d'), 37), other = f.json(id('e'), 41)
  const volume = f.file(`${rootName}/volumes/application/_data/${id('a')}-json.log`, Buffer.alloc(43))
  const home = f.file('home/user/database', Buffer.alloc(47))
  const archive = f.file(`${rootName}/containers/${id('a')}/${id('a')}-json.log.1`, Buffer.alloc(53))
  f.configure([{ id: id('a'), driver: 'json-file' }, { id: id('b'), driver: 'json-file' }, { id: id('c'), driver: 'local' }, { id: id('d'), driver: 'journald' }, { id: id('e'), driver: 'fluentd' }])
  const expected = [identity(first), identity(second)].sort(), before = f.run('check')
  expect(before.code, before.stderr).toBe(10)
  expect(parseCleanup(before.stdout)).toMatchObject({ bytes: 40, details: 'drivers=json-file=2 local=1 journald=1 other=1' })
  expect(before.stdout).not.toContain(f.root)
  expect(f.events('measured.ids').sort()).toEqual(expected)
  f.clearEvents()
  const applied = f.run('apply'); expect(applied.code, applied.stderr).toBe(0)
  expect(f.events('measured.ids').sort()).toEqual(expected)
  expect(f.events('truncated.ids').sort()).toEqual(expected)
  expect([identity(first), identity(second)].sort()).toEqual(expected)
  expect(fs.statSync(first).size + fs.statSync(second).size).toBe(0)
  for (const [file, size] of [[local, 31], [journal, 37], [other, 41], [volume, 43], [home, 47], [archive, 53]] as const) expect(fs.statSync(file).size).toBe(size)
  const again = f.run('check'); expect(again.code, again.stderr).toBe(0); expect(parseCleanup(again.stdout).bytes).toBe(0)
})

it('counts skipped drivers, treats absent JSON logs and an empty daemon as zero, and never reads arbitrary LogPath', () => {
  const f = fixture(), empty = f.run('check')
  expect(empty.code, empty.stderr).toBe(0)
  expect(parseCleanup(empty.stdout)).toMatchObject({ bytes: 0, details: 'drivers=json-file=0 local=0 journald=0 other=0' })
  for (const digit of ['a', 'b', 'c', 'd']) fs.mkdirSync(path.join(f.root, 'containers', id(digit)), { recursive: true })
  f.configure([{ id: id('a'), driver: 'json-file' }, { id: id('b'), driver: 'local' }, { id: id('c'), driver: 'journald' }, { id: id('d'), driver: 'none' }])
  expect(parseCleanup(f.run('check').stdout)).toMatchObject({ bytes: 0, details: 'drivers=json-file=1 local=1 journald=1 other=1' })
  expect(f.run('apply').code).toBe(0); expect(f.events('truncate-attempts')).toEqual([])
})

it.each(['root', 'ancestor', 'containers', 'container', 'file'] as const)('rejects a %s symlink without changing protected data', (boundary) => {
  const f = fixture('daemon/data'), log = f.json(id('a'), 11), protectedFile = f.file('home/user/protected', Buffer.alloc(71))
  f.configure([{ id: id('a'), driver: 'json-file' }])
  const replaced = { root: f.root, ancestor: path.dirname(f.root), containers: path.join(f.root, 'containers'), container: path.dirname(log), file: log }[boundary]
  fs.renameSync(replaced, `${replaced}.saved`)
  fs.symlinkSync(boundary === 'file' ? protectedFile : path.dirname(protectedFile), replaced)
  for (const phase of ['check', 'apply'] as const) expect(f.run(phase).code).toBe(20)
  expect(fs.statSync(protectedFile).size).toBe(71); expect(f.events('truncate-attempts')).toEqual([])
})

it('refuses a JSON log hard-linked to business data', () => {
  const f = fixture(), log = f.json(id('a'), 11), protectedFile = f.file('home/user/database', Buffer.alloc(79))
  fs.unlinkSync(log); fs.linkSync(protectedFile, log)
  f.configure([{ id: id('a'), driver: 'json-file' }])
  for (const phase of ['check', 'apply'] as const) expect(f.run(phase).code).toBe(20)
  expect(fs.statSync(protectedFile).size).toBe(79); expect(f.events('truncate-attempts')).toEqual([])
})

it.each(['containers', 'container', 'file'] as const)('refuses a %s on a different device', (boundary) => {
  const f = fixture(), log = f.json(id('a'), 11)
  f.configure([{ id: id('a'), driver: 'json-file' }])
  const foreign = { containers: path.join(f.root, 'containers'), container: path.dirname(log), file: log }[boundary]
  for (const phase of ['check', 'apply'] as const) expect(f.run(phase, { FOREIGN_FILE: foreign }).code).toBe(20)
  expect(fs.statSync(log).size).toBe(11); expect(f.events('truncate-attempts')).toEqual([])
})

it.each(['check', 'apply'] as const)('rejects a file replaced between stat and descriptor open during %s', (phase) => {
  const f = fixture(), log = f.json(id('a'), 11), protectedFile = f.file('home/user/database', Buffer.alloc(83))
  f.configure([{ id: id('a'), driver: 'json-file' }])
  const result = f.run(phase, { REPLACE_FILE: log, REPLACEMENT_TARGET: protectedFile })
  expect(result.code, result.stderr).toBe(20)
  expect(fs.statSync(protectedFile).size).toBe(83)
  expect(fs.statSync(`${log}.saved`).size).toBe(11); expect(f.events('truncate-attempts')).toEqual([])
})

// Debian/Ubuntu run `sh -s` with dash, whose pwd -P reports the cached path after the directory moves.
const shells = ['/bin/sh', ...(fs.existsSync('/bin/dash') ? ['/bin/dash'] : [])]
it.each(shells.flatMap(sh => (['check', 'apply'] as const).map(phase => [phase, sh] as const)))('rejects a container directory replaced after descriptor open during %s (%s)', (phase, sh) => {
  const f = fixture(), log = f.json(id('a'), 11), protectedFile = f.file(`home/user/${id('a')}-json.log`, Buffer.alloc(89))
  f.configure([{ id: id('a'), driver: 'json-file' }])
  const result = f.run(phase, { REPLACE_PARENT: path.dirname(log), REPLACEMENT_TARGET: path.dirname(protectedFile) }, sh)
  expect(result.code, result.stderr).toBe(20)
  expect(fs.statSync(protectedFile).size).toBe(89)
  expect(fs.statSync(path.join(`${path.dirname(log)}.saved`, path.basename(log))).size).toBe(11)
  expect(f.events('truncate-attempts')).toEqual([])
})

it.each(['', '/', 'relative', '/bad\nroot'])('rejects malformed daemon root %j without estimating or truncating', (root) => {
  const f = fixture(); f.configure([], { root })
  for (const phase of ['check', 'apply'] as const) expect(f.run(phase).code).toBe(20)
  expect(f.events('truncate-attempts')).toEqual([])
})

it.each(['short', 'g'.repeat(64), `${id('a')} ${id('b')}`, `${id('a')}\n${id('a')}`])('rejects malformed or duplicate container IDs %j', (ids) => {
  const f = fixture(); f.json(id('a'), 11); f.configure([{ id: id('a'), driver: 'json-file' }], { ids })
  const result = f.run('check'); expect(result.code, result.stderr).toBe(20); expect(parseCleanup(result.stdout).bytes).toBeNull()
})

it.each([`${id('b')} json-file`, `${id('a')} `, `${id('a')} <no value>`, `${id('a')} json-file extra`, `${id('a')} json-file\nlocal`])('rejects incomplete/mismatched inspect metadata %j', (inspect) => {
  const f = fixture(), log = f.json(id('a'), 11); f.configure([{ id: id('a'), inspect }])
  for (const phase of ['check', 'apply'] as const) expect(f.run(phase).code).toBe(20)
  expect(fs.statSync(log).size).toBe(11); expect(f.events('truncate-attempts')).toEqual([])
})

it.each(['info', 'list', 'inspect'] as const)('reports %s failures as unknown without guessed bytes', (fail) => {
  const f = fixture(); f.json(id('a'), 11); f.configure([{ id: id('a'), driver: 'json-file' }], { fail })
  const result = f.run('check'); expect(result.code).toBe(20); expect(parseCleanup(result.stdout).bytes).toBeNull()
})

it('does not publish raw daemon errors or private root paths', () => {
  const f = fixture()
  f.shell('docker', `printf '%s\\n' ${shellEscape(`private daemon root: ${f.root}; inspect configuration`)} >&2; exit 1`)
  for (const phase of ['check', 'apply'] as const) expect(f.run(phase)).toEqual({ code: 20, stdout: '', stderr: '' })
})

it.each(['docker', 'stat', 'awk', 'truncate'])('reports missing %s as unknown in the standalone script', (tool) => {
  const f = fixture(); f.json(id('a'), 11); f.configure([{ id: id('a'), driver: 'json-file' }]); f.prepare()
  fs.unlinkSync(path.join(f.bin, tool))
  const result = spawnSync('/bin/sh', ['-c', measure], { encoding: 'utf8', env: { PATH: f.bin }, timeout: 15_000 })
  if (result.error) throw result.error
  expect(result.status, result.stderr).toBe(20); expect(parseCleanup(result.stdout).bytes).toBeNull()
})

it.each(['not-a-size', '-1', '9007199254740992'])('rejects invalid or unsafe byte counts %s', (size) => {
  const f = fixture(); f.json(id('a'), 11); f.configure([{ id: id('a'), driver: 'json-file' }])
  const result = f.run('check', { BAD_SIZE: size }); expect(result.code).toBe(20); expect(parseCleanup(result.stdout).bytes).toBeNull()
})

it('checks, truncates the same inode, and verifies through loopback SSH without Docker', async () => {
  const f = fixture('remote data'), log = f.json(id('a'), 97), original = identity(log)
  f.configure([{ id: id('a'), driver: 'json-file' }])
  const server = await startMiniSshd({ username: 'docker-logs-fixture', password: 'fixture-only' })
  const opened = await connectEndpoint({ host: '127.0.0.1', port: server.port, username: 'docker-logs-fixture', auth: { authType: 'password', password: 'fixture-only', privateKey: null, privateKeyPath: null, passphrase: null } }, { verifyHost: async () => true, onKeyboard: async () => null })
  try {
    const before = await execOnClient(opened.client, f.remoteCommand('check'))
    expect(before.code, before.stderr).toBe(10); expect(parseCleanup(before.stdout).bytes).toBe(97)
    const applied = await execOnClient(opened.client, f.remoteCommand('apply')); expect(applied.code, applied.stderr).toBe(0)
    const after = await execOnClient(opened.client, f.remoteCommand('check'))
    expect(after.code, after.stderr).toBe(0); expect(parseCleanup(after.stdout).bytes).toBe(0)
    expect(identity(log)).toBe(original)
  } finally { opened.client.end(); await server.close() }
})
