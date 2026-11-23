import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'
import { execReadOnly } from '../src/main/ssh/read-only-exec'
import { shellEscape } from '../src/core/shell'
import { parseCleanup } from '../src/core/runbook/cleanup'
import { generateAgentKey } from './support/mini-agent.mjs'

const { Server } = createRequire(import.meta.url)('ssh2')
const dispose: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of dispose.reverse()) await cleanup(); dispose.length = 0 })
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(condition: () => boolean) {
  const until = Date.now() + 8_000
  while (!condition()) { if (Date.now() > until) throw new Error('fixture did not become ready'); await delay(20) }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/**
 * The SSH server deliberately does NOT kill child processes on channel close.
 * On macOS, a setsid/proc fixture supplies Linux identity fields while Node's
 * detached spawn creates REAL process groups; TERM/KILL reach real descendants.
 * This is transport/process-lifetime coverage, not a Linux /proc integration claim.
 */
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-cancel-'))
  const bin = path.join(directory, 'bin'), proc = path.join(directory, 'proc')
  fs.mkdirSync(bin); fs.mkdirSync(path.join(proc, 'self'), { recursive: true }); fs.writeFileSync(path.join(proc, 'self', 'stat'), '')
  const processes = new Set<ChildProcess>(), clients = new Set<any>(), commands: string[] = []
  const faults = { denyGroupProbe: false }
  fs.writeFileSync(path.join(bin, 'setsid'), `#!${process.execPath}
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const args=process.argv.slice(2);if(args[0]!=='sh'||args[1]!=='-c')process.exit(125);
const gate='while [ ! -r "$HL_TEST_PROC/$$/stat" ]; do sleep 0.01; done\\n';
const child=spawn(args[0],[args[1],gate+args[2],...args.slice(3)],{detached:true,env:process.env,stdio:['pipe','pipe','pipe','pipe']});
const root=path.join(process.env.HL_TEST_PROC,String(child.pid));fs.mkdirSync(root);
const fields=Array(20).fill('0');fields[0]='S';fields[1]=String(process.pid);fields[2]=fields[3]=String(child.pid);fields[19]=String(Date.now());
fs.writeFileSync(path.join(root,'stat'),child.pid+' (sh) '+fields.join(' '));
fs.writeFileSync(path.join(root,'cmdline'),args.join('\\0')+'\\0');
fs.appendFileSync(process.env.HL_TEST_GROUPS,child.pid+'\\n');
process.stdin.pipe(child.stdin);process.stdin.pipe(child.stdio[3]);child.stdin.on('error',()=>{});child.stdio[3].on('error',()=>{});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.once('exit',(code)=>{fs.rmSync(root,{recursive:true,force:true});process.exit(code??137)});
`, { mode: 0o700 })
  // Fake sudo requires a password on every independent exec and discards its stdin.
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh\n[ "$1" = -S ] && [ "$2" = -p ] && [ "$3" = '' ] || exit 90\nshift 3\nIFS= read -r password\n[ "$password" = test-private ] || exit 1\nexec "$@"\n`, { mode: 0o700 })
  const groups = path.join(directory, 'groups'); fs.writeFileSync(groups, '')
  const server = new Server({ hostKeys: [generateAgentKey().private] }, (client: any) => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx: any) => ctx.username === 'cleanup' && ctx.method === 'password' && ctx.password === 'test-only' ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', (accept: any) => {
      const session = accept()
      session.on('exec', (acceptExec: any, _reject: any, info: { command: string }) => {
        commands.push(info.command)
        const stream = acceptExec()
        const command = (faults.denyGroupProbe && info.command.includes('for attempt in 1 2 3') ? "kill() { printf 'Operation not permitted' >&2; return 1; }\n" : '') + info.command
        const child = spawn('sh', ['-c', command.replaceAll('/proc/', `${proc}/`)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HL_TEST_PROC: proc, HL_TEST_GROUPS: groups }, stdio: ['pipe', 'pipe', 'pipe'] })
        processes.add(child); child.on('error', () => {}); child.stdin.on('error', () => {})
        stream.pipe(child.stdin); child.stdout.on('data', (chunk) => { if (!stream.destroyed) stream.write(chunk) }); child.stderr.on('data', (chunk) => { if (!stream.destroyed) stream.stderr.write(chunk) })
        stream.on('error', () => {})
        // No child.kill here: closing an SSH channel must not make the test pass.
        child.on('close', (code) => { processes.delete(child); if (!stream.destroyed) { stream.exit(code ?? 137); stream.end() } })
      })
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const host = vault.saveHost({ groupId: null, name: 'loopback', host: '127.0.0.1', port: server.address().port, username: 'cleanup', authType: 'password', password: 'test-only' })
  const pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null })
  dispose.push(async () => {
    await pool.closeAll(); for (const client of clients) client.end()
    for (const raw of fs.readFileSync(groups, 'utf8').trim().split('\n')) if (/^\d+$/.test(raw)) { try { process.kill(-Number(raw), 'SIGKILL') } catch {} }
    for (const child of processes) child.kill('SIGKILL')
    await new Promise<void>((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, bin, proc, groups, pool, host, commands, faults }
}

it('actually kills a TERM-resistant descendant before reporting cancellation, preserving unrelated processes', async () => {
  const f = await fixture(), controller = new AbortController(), pidfile = path.join(f.directory, 'worker.pid')
  const unrelated = spawn('sleep', ['30']); dispose.push(() => { unrelated.kill('SIGKILL') })
  const command = `sh -c ${shellEscape(`trap '' TERM; echo $$ > ${shellEscape(pidfile)}; sleep 30 & echo $! >> ${shellEscape(pidfile)}; wait`)} & wait`
  const work = execReadOnly(f.pool, f.host.id, command, { signal: controller.signal })
  const outcome = work.catch((error) => error)
  await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, 'utf8').trim().split('\n').length === 2)
  const workers = fs.readFileSync(pidfile, 'utf8').trim().split('\n').map(Number); expect(workers.every(alive)).toBe(true)
  controller.abort()
  expect(await outcome).toMatchObject({ name: 'AbortError', message: 'cleanup.readOnlyCanceled' })
  await until(() => workers.every((pid) => !alive(pid)))
  expect(alive(unrelated.pid!)).toBe(true)
})

it('sends sudo passwords only through stdin on both execution and cancellation, never in commands/results', async () => {
  const f = await fixture(), controller = new AbortController(), pidfile = path.join(f.directory, 'sudo.pid')
  const work = execReadOnly(f.pool, f.host.id, `echo $$ > ${shellEscape(pidfile)}; sleep 30`, { signal: controller.signal, sudo: { mode: 'password', password: 'test-private' } })
  const outcome = work.catch((error) => error)
  await until(() => fs.existsSync(pidfile)); const pid = Number(fs.readFileSync(pidfile, 'utf8'))
  controller.abort()
  expect(await outcome).toMatchObject({ message: 'cleanup.readOnlyCanceled' })
  await until(() => !alive(pid))
  expect(f.commands.filter((command) => command.startsWith('sudo -S')).length).toBe(3)
  expect(f.commands.join('\n')).not.toContain('test-private')
})

it('times out by terminating the process group and preserves partial output without leaking its handshake', async () => {
  const f = await fixture(), pidfile = path.join(f.directory, 'timeout.pid')
  const result = await execReadOnly(f.pool, f.host.id, `echo $$ > ${shellEscape(pidfile)}; printf '16\\t/fixture\\n'; sleep 30`, { timeoutMs: 1_000 })
  expect(result).toMatchObject({ timedOut: true, stdout: '16\t/fixture\n' })
  await until(() => !alive(Number(fs.readFileSync(pidfile, 'utf8'))))
  expect(result.stdout).not.toContain('hopline-readonly')
})

it('does not start a command that was already canceled', async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort()
  await expect(execReadOnly(f.pool, f.host.id, 'echo must-not-run', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.commands).toHaveLength(0)
})

it('returns unavailable when the process-group capability is absent, without starting the payload', async () => {
  const f = await fixture(), marker = path.join(f.directory, 'must-not-exist')
  fs.writeFileSync(path.join(f.bin, 'setsid'), '#!/bin/sh\nexit 125\n', { mode: 0o700 })
  await expect(execReadOnly(f.pool, f.host.id, `touch ${shellEscape(marker)}`)).rejects.toThrow('cleanup.readOnlyUnavailable')
  expect(fs.existsSync(marker)).toBe(false)
})


it('preserves successful payload exit codes and caps payload output after removing control metadata', async () => {
  const f = await fixture()
  expect(await execReadOnly(f.pool, f.host.id, "printf 'bytes=64\\n'; exit 10")).toMatchObject({ code: 10, stdout: 'bytes=64\n', signal: null, truncated: false })
  const result = await execReadOnly(f.pool, f.host.id, "printf '1234567890'", { maxOutputBytes: 5 })
  expect(result.stdout).toBe('12345'); expect(result.truncated).toBe(true)
  expect(result.stderr).not.toContain('hopline-readonly')
})


it('waits for ownership handshake when canceled during startup and then terminates that group', async () => {
  const f = await fixture(), controller = new AbortController()
  const shim = path.join(f.bin, 'setsid')
  fs.writeFileSync(shim, fs.readFileSync(shim, 'utf8').replace("const gate='while", "const gate='sleep 0.3; while"), { mode: 0o700 })
  const work = execReadOnly(f.pool, f.host.id, 'sleep 30', { signal: controller.signal })
  const outcome = work.catch((error) => error)
  await until(() => fs.readFileSync(f.groups, 'utf8').trim().length > 0)
  const leader = Number(fs.readFileSync(f.groups, 'utf8').trim())
  controller.abort()
  expect(await outcome).toMatchObject({ name: 'AbortError', message: 'cleanup.readOnlyCanceled' })
  await until(() => !alive(leader))
})

it('refuses to signal a mismatched process identity and reports unconfirmed cancellation until the watchdog stops its group', async () => {
  const f = await fixture(), controller = new AbortController(), pidfile = path.join(f.directory, 'identity.pid')
  const work = execReadOnly(f.pool, f.host.id, `echo $$ > ${shellEscape(pidfile)}; sleep 30`, { signal: controller.signal, timeoutMs: 3_000 })
  const outcome = work.catch((error) => error)
  // Redirection creates an empty file before echo writes the PID. Never let
  // Number('') become 0: kill(0, 0) would probe this test's own process group.
  await until(() => fs.existsSync(pidfile) && /^[1-9]\d*\n$/.test(fs.readFileSync(pidfile, 'utf8')) &&
    /^[1-9]\d*\n$/.test(fs.readFileSync(f.groups, 'utf8')))
  const worker = Number(fs.readFileSync(pidfile, 'utf8')), leader = fs.readFileSync(f.groups, 'utf8').trim()
  expect(worker).toBeGreaterThan(0)
  fs.writeFileSync(path.join(f.proc, leader, 'cmdline'), 'unrelated-process\0')
  controller.abort()
  expect(await outcome).toMatchObject({ message: 'cleanup.cancelUnconfirmed' })
  expect(alive(worker)).toBe(true) // The SSH fixture did not secretly kill it on channel close.
  await until(() => !alive(worker)) // The remote watchdog remains responsible after transport failure.
})


it.each(['id -u', "sudo -S -p '' -v"])('really stops a delayed permission probe %s including its descendant', async (probe) => {
  const f = await fixture(), controller = new AbortController(), pidfile = path.join(f.directory, 'probe.pid')
  const password = 'test-probe-private'
  const command = probe.startsWith('sudo') ? 'sudo' : 'id'
  fs.writeFileSync(path.join(f.bin, command), `#!/bin/sh\n${command === 'sudo' ? `IFS= read -r password\n[ "$password" = '${password}' ] || exit 99\n` : ''}echo $$ > ${shellEscape(pidfile)}\nsleep 30 & echo $! >> ${shellEscape(pidfile)}\nwait\n`, { mode: 0o700 })
  const work = execReadOnly(f.pool, f.host.id, probe, { signal: controller.signal, ...(command === 'sudo' ? { stdin: `${password}\n` } : {}) })
  const outcome = work.catch((error) => error)
  await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, 'utf8').trim().split('\n').length === 2)
  const workers = fs.readFileSync(pidfile, 'utf8').trim().split('\n').map(Number)
  controller.abort()
  expect(await outcome).toMatchObject({ name: 'AbortError', message: 'cleanup.readOnlyCanceled' })
  await until(() => workers.every((pid) => !alive(pid)))
  expect(f.commands.join('\n')).not.toContain(password)
})

it('passes one-line probe input via fd3, redacts reflections and rejects mixed credential modes before execution', async () => {
  const f = await fixture(), password = 'test-probe-private'
  expect(await execReadOnly(f.pool, f.host.id, 'IFS= read -r value; printf "%s" "$value"', { stdin: `${password}\n` })).toMatchObject({ code: 0, stdout: '***', stderr: '' })
  expect(f.commands.join('\n')).not.toContain(password)
  const count = f.commands.length
  await expect(execReadOnly(f.pool, f.host.id, 'echo must-not-start', { stdin: `${password}\n`, sudo: { mode: 'password', password } })).rejects.toThrow('cleanup.readOnlyUnavailable')
  expect(f.commands).toHaveLength(count)
})

it('does not confuse inaccessible remaining group members with an empty group', async () => {
  const f = await fixture(), controller = new AbortController(), pidfile = path.join(f.directory, 'permission.pid')
  f.faults.denyGroupProbe = true
  const work = execReadOnly(f.pool, f.host.id, `echo $$ > ${shellEscape(pidfile)}; sleep 30`, { signal: controller.signal })
  const outcome = work.catch((error) => error)
  await until(() => fs.existsSync(pidfile))
  controller.abort()
  expect(await outcome).toMatchObject({ message: 'cleanup.cancelUnconfirmed' })
})


it('keeps numeric measurements intact with a matching numeric sudo password for internal parsing', async () => {
  const f = await fixture(), sudo = path.join(f.bin, 'sudo')
  fs.writeFileSync(sudo, fs.readFileSync(sudo, 'utf8').replace('test-private', '1234'), { mode: 0o700 })
  const result = await execReadOnly(f.pool, f.host.id, "printf 'bytes=%s\\n' $((1200 + 34)); exit 10", { sudo: { mode: 'password', password: '1234' } })
  expect(result.code).toBe(10)
  expect(parseCleanup(result.stdout).bytes).toBe(1234)
  // Internal raw results are not written to an operation log; service/engine own
  // string redaction after extracting the numerical measurement.
  expect(result.stdout).toBe('bytes=1234\n')
})
