import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { COLLECT_SCRIPT } from '../src/core/collect/script'
import { parseCollect } from '../src/core/collect/parse'

let directory: string
const write = (name: string, text: string) => {
  const file = path.join(directory, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}
const command = (name: string, text: string) => fs.chmodSync(write(`bin/${name}`, `#!/bin/sh\n${text}\n`), 0o755)
function collect() {
  const script = COLLECT_SCRIPT.replaceAll('/etc/', `${directory}/etc/`).replaceAll('/proc/', `${directory}/proc/`)
  const output = execFileSync('/bin/sh', ['-s'], { input: script, encoding: 'utf8', timeout: 20_000, env: { ...process.env, PATH: `${directory}/bin:/usr/bin:/bin` } })
  return { output, snapshot: parseCollect(output, 123) }
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-collect-'))
  write('etc/os-release', 'ID=alpine\nVERSION_ID=3.20\nNAME="Alpine Linux"\n')
  write('proc/uptime', '12.5 20\n')
  write('proc/cpuinfo', 'processor : 0\nprocessor : 1\n')
  write('proc/stat', 'cpu 1 2 3 4 5 6 7 8 0 0\n')
  write('proc/meminfo', 'MemTotal: 100 kB\nMemAvailable: 50 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n')
  write('proc/loadavg', '0.1 0.2 0.3 1/10 12\n')
  write('proc/mounts', '/dev/root / ext4 rw 0 0\n')
  write('proc/1/comm', 'sshd\n')
  command('uname', 'echo "Linux 6.12 aarch64"')
  command('nproc', 'exit 127')
  command('sleep', '[ "$1" = 1 ]')
  command('df', '[ "$1 $2" = "-P -k" ] || exit 1\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/root 100 40 60 40%% /\\n"')
  command('ss', '[ "$1" = -Htlnp ] || exit 1\necho "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*"')
  command('netstat', '[ "$1" = -tlnp ] || exit 1\necho "tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 1/sshd"')
  command('docker', 'echo "permission denied while trying to connect to the Docker daemon socket" >&2\nexit 1')
  command('openssl', '[ "$1 $2" = "x509 -in" ] || exit 1\necho "notAfter=Nov 27 10:20:30 2026 GMT"\necho "subject=CN = example.com"')
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

it('keeps the distro probe byte-for-byte identical and valid POSIX shell syntax', () => {
  expect(fs.readFileSync(path.join(import.meta.dirname, 'distro/probes/collect.sh'), 'utf8')).toBe(COLLECT_SCRIPT)
  expect(() => execFileSync('/bin/sh', ['-n'], { input: COLLECT_SCRIPT })).not.toThrow()
})
it('executes the whole script read-only, captures failures and continues to later sections', () => {
  const { output, snapshot } = collect()
  expect(output.match(/^===HOPLINE:/gm)).toHaveLength(11)
  expect(output.match(/^#HOPLINE-END$/gm)).toHaveLength(11)
  expect(snapshot.os.status).toBe('complete')
  expect(snapshot.cpu).toEqual({ status: 'complete', data: { cores: 2, usagePercent: 0 } })
  expect(snapshot.memory).toEqual({ status: 'complete', data: { totalBytes: 102400, availableBytes: 51200, swapTotalBytes: 0, swapUsedBytes: 0 } })
  expect(snapshot.listeners.status).toBe('partial')
  expect(snapshot.docker).toMatchObject({ status: 'unavailable', reason: 'permission-denied' })
  expect(snapshot.services).toMatchObject({ status: 'unavailable', reason: 'not-applicable' })
  expect(snapshot.web).toMatchObject({ status: 'unavailable', reason: 'not-installed' })
  expect(snapshot.certs).toEqual({ status: 'complete', data: [] })
})
it('uses netstat when ss is absent and collects installed services, sites and certificates', () => {
  fs.unlinkSync(path.join(directory, 'bin/ss'))
  // Hide any host ss while retaining the real POSIX utilities used by the script.
  for (const name of ['cat', 'awk', 'head', 'tr', 'sed', 'sort', 'grep', 'find', 'dirname']) {
    const binary = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim()
    fs.symlinkSync(binary, path.join(directory, 'bin', name))
  }
  write('proc/1/comm', 'systemd\n')
  command('systemctl', '[ "$*" = "list-units --type=service --state=running --no-legend --plain" ] || exit 1\necho "ssh.service loaded active running OpenBSD Secure Shell server"')
  command('docker', '[ "$1 $2 $3" = "ps --format {{json .}}" ] || exit 1\necho \'{"Names":"app","Image":"app:v1","Status":"Up","Ports":""}\'')
  write('etc/nginx/sites-enabled/default', 'server { server_name example.com; }\n')
  write('etc/caddy/Caddyfile', 'caddy.example.com {\nrespond "Hi"\n}\n')
  write('etc/letsencrypt/live/example.com/cert.pem', 'stub certificate')
  const script = COLLECT_SCRIPT.replaceAll('/etc/', `${directory}/etc/`).replaceAll('/proc/', `${directory}/proc/`)
  const output = execFileSync('/bin/sh', ['-s'], { input: script, encoding: 'utf8', timeout: 20_000, env: { ...process.env, PATH: `${directory}/bin` } })
  const snapshot = parseCollect(output, 123)
  expect(snapshot.listeners).toMatchObject({ status: 'complete', data: [{ process: 'sshd' }] })
  expect(snapshot.docker).toMatchObject({ status: 'complete', data: [{ name: 'app' }] })
  expect(snapshot.services).toMatchObject({ status: 'complete', data: [{ name: 'ssh.service' }] })
  expect(snapshot.web).toEqual({ status: 'complete', data: [{ source: 'nginx', domain: 'example.com' }, { source: 'caddy', domain: 'caddy.example.com' }] })
  expect(snapshot.certs).toMatchObject({ status: 'partial', data: [{ domain: 'example.com', unreferenced: true }] })
})
it('bounds stderr, separates stdout from diagnostics and retains partial successes', () => {
  command('df', 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/root 100 40 60 40% /"\necho "unreadable mount" >&2\nexit 1')
  command('docker', `printf '%s\\n' '${'x'.repeat(300)}' >&2\nexit 1`)
  const { snapshot } = collect()
  expect(snapshot.disk).toMatchObject({ status: 'partial', data: [{ mountpoint: '/' }], note: 'unreadable mount' })
  expect(snapshot.docker).toMatchObject({ status: 'unavailable', reason: 'error' })
  expect(snapshot.docker.note).toHaveLength(200)
  expect(snapshot.certs.status).toBe('complete')
})
it('marks successful command warnings as partial and identifies missing commands', () => {
  command('ss', 'echo "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*"\necho "process access restricted" >&2')
  command('docker', 'echo "docker: not found" >&2\nexit 127')
  const { snapshot } = collect()
  expect(snapshot.listeners).toMatchObject({ status: 'partial', note: 'process access restricted' })
  expect(snapshot.docker).toMatchObject({ status: 'unavailable', reason: 'not-installed' })
})
