import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SECURITY_SCRIPT } from '../src/core/security/script'
import { COLLECT_SCRIPT } from '../src/core/collect/script'
import { parseSecurity } from '../src/core/security/parse'
import { SecurityService } from '../src/main/security-service'
import { OpLog } from '../src/main/oplog'
import { connectEndpoint } from '../src/main/ssh/connect'
import { execOnClient } from '../src/main/ssh/exec'
import { startMiniSshd } from './support/mini-sshd.mjs'
import { shellEscape } from '../src/core/shell'
let directory: string
const write = (name: string, value: string) => { const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file }
const command = (name: string, body: string) => fs.chmodSync(write(`bin/${name}`, `#!/bin/sh\n${body}\n`), 0o755)
const isolate = (script: string) => script.replace(/\/(?:etc|var)\//g, (prefix) => `${directory}${prefix}`).replaceAll('/usr/sbin:/usr/bin:/sbin:/bin', `${directory}/bin:/usr/bin:/bin`)
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-security-script-'))
  command('id', 'echo 0'); command('sudo', 'exit 1')
  command('sshd', 'echo "permitrootlogin yes"; echo "passwordauthentication yes"; echo "permitemptypasswords no"; echo "port 2222"')
  command('ufw', 'echo "Status: inactive"'); command('nft', 'exit 0'); command('iptables', 'echo "-P INPUT ACCEPT"'); command('firewall-cmd', 'echo "not running"; exit 252')
  command('ss', 'echo \'LISTEN 0 128 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=1,fd=1))\'')
  command('apt-config', 'echo \'APT::Periodic::Unattended-Upgrade "1";\''); command('unattended-upgrade', 'exit 0')
  command('apt-get', 'echo "Inst openssl (1.2 Ubuntu:24.04/noble-security [amd64])"')
  command('timeout', `printf '%s\\n' "$*" >> '${directory}/timeouts'; shift; exec "$@"`)
  command('pgrep', 'exit 1'); command('ps', 'echo " PID USER %CPU COMMAND COMMAND"; echo " 42 root 99 xmrig xmrig"')
  command('nginx', 'exit 1')
  command('openssl', `printf '%s\\n' "$*" >> '${directory}/openssl'; if [ "$1" = s_client ]; then echo PEM; else echo "notAfter=Jan 1 00:00:00 2027 GMT"; echo "subject=CN = example.com"; fi`)
  write('etc/os-release', 'ID=debian\nVERSION_ID=12\nNAME=Debian\n')
  write('etc/passwd', 'root:x:0:0::/root:/bin/sh\nbackup:x:0:0::/:/bin/sh\n')
  write('etc/shadow', 'root:!:0::::::\nguest::0::::::\n')
  write('etc/nginx/nginx.conf', `server { server_name one.example; ssl_certificate ${directory}/etc/letsencrypt/live/one/fullchain.pem; }\nserver { server_name two.example; ssl_certificate ${directory}/etc/custom/two.pem; include snippets/tls.conf; }\n`)
  write('etc/letsencrypt/live/one/cert.pem', 'stub'); write('etc/letsencrypt/live/orphan/cert.pem', 'stub')
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
it('ships identical distro probes and POSIX-valid scripts', () => {
  expect(fs.readFileSync(new URL('./distro/probes/security.sh', import.meta.url), 'utf8')).toBe(SECURITY_SCRIPT)
  expect(fs.readFileSync(new URL('./distro/probes/collect.sh', import.meta.url), 'utf8')).toBe(COLLECT_SCRIPT)
  execFileSync('/bin/sh', ['-n'], { input: SECURITY_SCRIPT })
})
it('executes all sections, expands reference paths in multiple server blocks, bounds queries and probes only local listeners', () => {
  const stdout = execFileSync('/bin/sh', ['-c', isolate(SECURITY_SCRIPT)], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${directory}/bin:/usr/bin:/bin` } })
  const s = parseSecurity(stdout, 0)
  expect(stdout.match(/^#HOPLINE-END$/gm)).toHaveLength(9)
  expect(s.sshd).toMatchObject({ status: 'complete', data: { permitrootlogin: 'yes', port: '2222' } })
  expect(s.firewall).toMatchObject({ data: { active: false } })
  expect(s.updates).toMatchObject({ data: { auto: true, pending: 1, reboot: false } })
  expect(s.accounts).toMatchObject({ data: { uid0: ['root', 'backup'], empty: ['guest'] } })
  expect(s.tls.status).toBe('partial')
  if (s.tls.status !== 'unavailable') expect(s.tls.data.map((r) => r.unreferenced)).toEqual([false, false, true, false, false])
  const commands = fs.readFileSync(path.join(directory, 'openssl'), 'utf8')
  expect(commands).toContain('s_client -connect 127.0.0.1:443 -servername one.example')
  expect(commands).toContain('s_client -connect 127.0.0.1:443 -servername two.example')
  const timeouts = fs.readFileSync(path.join(directory, 'timeouts'), 'utf8')
  expect(timeouts).toContain('20 apt-get -s upgrade')
  expect(timeouts.match(/^3 openssl/gm)).toHaveLength(2)
})
it('caps TLS probes at ten names and rejects shell syntax in remote server names', () => {
  write('etc/nginx/nginx.conf', `server { server_name ${Array.from({ length: 20 }, (_, i) => `n${i}.example`).join(' ')} $(touch /tmp/hopline-injected) -evil; }`)
  execFileSync('/bin/sh', ['-c', isolate(SECURITY_SCRIPT)], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${directory}/bin:/usr/bin:/bin` } })
  const commands = fs.readFileSync(path.join(directory, 'openssl'), 'utf8')
  expect(commands.match(/^s_client /gm)?.length).toBeLessThanOrEqual(10)
  expect(commands).not.toContain('touch')
})
it('runs the read-only collector through loopback mini-sshd and the real SSH execution adapter', async () => {
  const server = await startMiniSshd({ username: 'hop', password: 'local-only' })
  const opened = await connectEndpoint({ host: '127.0.0.1', port: server.port, username: 'hop', auth: { authType: 'password', password: 'local-only', privateKey: null, privateKeyPath: null, passphrase: null } }, { verifyHost: async () => true, onKeyboard: async () => null })
  try {
    const diagnostics: Record<string, unknown>[] = []
    const pool = { exec: async (_id: string, script: string, options = {}) => {
      const started = Date.now(), commandIndex = diagnostics.length + 1
      try {
        const result = await execOnClient(opened.client, `PATH=${shellEscape(`${directory}/bin:/usr/bin:/bin`)} ${isolate(script)}`, options)
        diagnostics.push({ commandIndex, elapsedMs: Date.now() - started, code: result.code, signal: result.signal,
          timedOut: result.timedOut, truncated: result.truncated, stdout: result.stdout.slice(-4096), stderr: result.stderr.slice(-4096) })
        return result
      } catch (error) {
        diagnostics.push({ commandIndex, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    } }
    const service = new SecurityService(directory, pool, new OpLog(path.join(directory, 'oplog')), () => true)
    const result = await service.check('loopback').catch(error => {
      // Only this fixture's bounded output is included; never log SSH credentials or scripts.
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nsecurity fixture diagnostic: ${JSON.stringify(diagnostics)}`, { cause: error })
    })
    expect(result.results.find((r) => r.id === 'ssh-root-login')?.status).toBe('fail')
    expect(result.results.find((r) => r.id === 'miner-process')?.status).toBe('fail')
    expect(service.latest('loopback')?.score).toBe(result.score)
  } finally { opened.client.end(); await server.close() }
})

const yumTools = (() => {
  const lines = execFileSync('/bin/sh', ['-c', 'command -v grep && command -v awk'], { encoding: 'utf8' }).trim().split('\n')
  return { grep: lines[0]!, awk: lines[1]! }
})()

/** Run only updates with an allowlisted PATH, independent of the test host's package manager. */
function yumOnly(output = 'echo "RHSA-2020:1234 Important/Sec. openssl-1.0.2k-19.el7.x86_64"') {
  for (const name of ['apt-get', 'apt-config', 'unattended-upgrade']) fs.rmSync(path.join(directory, 'bin', name))
  for (const [name, location] of Object.entries(yumTools)) fs.symlinkSync(location, path.join(directory, 'bin', name))
  command('timeout', `printf '%s\\n' "$*" >> '${directory}/timeouts'; if [ "$1" = -s ]; then shift 2; fi; shift; exec "$@"`)
  command('systemctl', 'printf "LoadState=loaded\\nUnitFileState=enabled\\nActiveState=active\\n"')
  command('yum', `printf '%s\\n' "$*" >> '${directory}/yum-commands'; ${output}`)
  write('etc/yum/yum-cron.conf', '[commands]\napply_updates = yes\ndownload_updates = yes\n')
  const script = SECURITY_SCRIPT.slice(SECURITY_SCRIPT.lastIndexOf('#!/bin/sh')).replace('for name in os sshd firewall listeners updates bruteforce accounts processes tls; do section "$name"; done', 'section updates')
  return () => execFileSync('/bin/sh', ['-c', isolate(script).replaceAll(`${directory}/bin:/usr/bin:/bin`, `${directory}/bin`)], { encoding: 'utf8', timeout: 30000 })
}
it('queries only cached yum security metadata with plugins disabled and a hard 20-second limit', () => {
  const stdout = yumOnly()()
  expect(parseSecurity(stdout, 0).updates).toMatchObject({ status: 'complete', data: { auto: true, pending: 1 } })
  expect(fs.readFileSync(path.join(directory, 'yum-commands'), 'utf8')).toBe('-C -q --noplugins --setopt=logfile=/dev/null updateinfo list security\n')
  expect(fs.readFileSync(path.join(directory, 'timeouts'), 'utf8')).toContain('-s KILL 20 yum -C -q --noplugins --setopt=logfile=/dev/null updateinfo list security')
})
it.each([
  ['no cache', 'echo "Cache-only enabled but no cache for base"; exit 1'],
  ['empty metadata', 'exit 0'],
  ['partial failed query', 'echo "RHSA-2020:1234 Important/Sec. openssl"; exit 1']
])('keeps the yum pending count unknown for %s', (_name, output) => {
  expect(parseSecurity(yumOnly(output)(), 0).updates).toMatchObject({ status: 'partial', data: { pending: null, auto: true } })
})
it.each([124, 137])('does not accept a timed-out yum query with exit status %s', (code) => {
  const run = yumOnly()
  command('timeout', `case "$*" in *'20 yum '*) echo 'RHSA-2020:1234 Important/Sec. openssl'; exit ${code};; esac; shift 3; exec "$@"`)
  expect(parseSecurity(run(), 0).updates).toMatchObject({ status: 'partial', data: { pending: null } })
  expect(fs.existsSync(path.join(directory, 'yum-commands'))).toBe(false)
})
it('never runs yum without a timeout utility', () => {
  const run = yumOnly()
  fs.rmSync(path.join(directory, 'bin/timeout'))
  expect(parseSecurity(run(), 0).updates).toMatchObject({ status: 'partial', data: { auto: null, pending: null } })
  expect(fs.existsSync(path.join(directory, 'yum-commands'))).toBe(false)
})
it.each([
  ['disabled', 'printf "LoadState=loaded\\nUnitFileState=disabled\\nActiveState=active\\n"', false],
  ['inactive', 'printf "LoadState=loaded\\nUnitFileState=enabled\\nActiveState=inactive\\n"', false],
  ['failed D-Bus', 'exit 1', null],
  ['unknown unit state', 'printf "LoadState=loaded\\nUnitFileState=static\\nActiveState=active\\n"', null],
  ['inactive crond', 'if [ "$2" = crond.service ]; then printf "LoadState=loaded\\nUnitFileState=enabled\\nActiveState=inactive\\n"; else printf "LoadState=loaded\\nUnitFileState=enabled\\nActiveState=active\\n"; fi', false]
])('uses effective yum-cron and crond service state: %s', (_name, service, auto) => {
  const run = yumOnly()
  command('systemctl', service)
  expect(parseSecurity(run(), 0).updates).toMatchObject({ data: { auto, pending: 1 } })
})
it.each([
  ['[commands]\napply_updates=no\ndownload_updates=yes\n', false],
  ['[commands]\napply_updates=yes\n', false],
  ['[commands]\napply_updates=yes\ndownload_updates=yes\n    unexpected continuation\n', null],
  ['[commands]\napply_updates=yes\ndownload_updates=no\n', false],
  ['[commands]\napply_updates=yes\napply_updates=no\n[base]\napply_updates=yes\n', false],
  ['[commands]\napply_updates=on\ndownload_updates=TRUE\n', true],
  ['[commands]\n# apply_updates=yes\n', false],
  ['[commands]\napply_updates=maybe\n', null],
  ['[commands]\napply_updates=yes\ninclude=https://example.invalid/config\n', null],
  ['[base]\napply_updates=yes\n', null]
])('reads effective yum-cron command settings conservatively: %s', (config, auto) => {
  const run = yumOnly()
  write('etc/yum/yum-cron.conf', config)
  expect(parseSecurity(run(), 0).updates).toMatchObject({ data: { auto, pending: 1 } })
})
it('recognizes hourly auto-application and does not treat missing configuration as disabled', () => {
  const run = yumOnly()
  fs.rmSync(path.join(directory, 'etc/yum/yum-cron.conf'))
  expect(parseSecurity(run(), 0).updates).toMatchObject({ status: 'partial', data: { auto: null } })
  write('etc/yum/yum-cron.conf', '[commands]\napply_updates=no\n')
  write('etc/yum/yum-cron-hourly.conf', '[commands]\napply_updates=yes\ndownload_updates=yes\n')
  expect(parseSecurity(run(), 0).updates).toMatchObject({ data: { auto: true } })
})
