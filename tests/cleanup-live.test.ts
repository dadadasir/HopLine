import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startMiniSshd } from './support/mini-sshd.mjs'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'
import { cleanupExecution, cleanupRunbook, cleanupDuCommand, cleanupDuOutput, parseCleanup } from '../src/core/runbook/cleanup'
import { envCommand } from '../src/core/runbook/engine'
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; vi.unstubAllEnvs() })
async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-live-')); cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin)
  const shim = (name: string, script: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o700 })
  shim('id', 'echo 0')
  // Only read-only check commands are allowed. Never invoke a local Docker daemon.
  shim('docker', 'case "$*" in info) exit 0 ;; "system df"*) printf "1.5GB (100%%)\\n" ;; *) exit 90 ;; esac')
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  const server = await startMiniSshd({ username: 'cleanup', password: 'test-only' }); cleanups.push(() => server.close())
  const vault = new Vault(emptyStore(), new MemorySecretCodec()), host = vault.saveHost({ groupId: null, name: 'loopback', host: '127.0.0.1', port: server.port, username: 'cleanup', authType: 'password', password: 'test-only' })
  const pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null }); cleanups.push(() => pool.closeAll())
  return { directory, bin, server, pool, host, shim }
}
it('runs a read-only cleanup check over loopback SSH and keeps its measurement/details', async () => {
  const f = await setup(), step = cleanupRunbook.steps.find((step) => step.id === 'docker-build-cache')!
  const measured = cleanupExecution((script, { env, stdin }) => f.pool.exec(f.host.id, envCommand(script, env), { stdin }))
  expect(await measured.exec(step.check, { env: {} })).toMatchObject({ code: 10 })
  expect(measured.estimates[step.id]).toMatchObject({ bytes: 1_500_000_000, details: 'docker build cache: 1500000000 bytes' })
  f.shim('dnf', 'exit 90')
  const osRelease = path.join(f.directory, 'os-release'); fs.writeFileSync(osRelease, 'ID=rocky\nID_LIKE=\"rhel centos fedora\"\n')
  const cache = cleanupRunbook.steps.find((step) => step.id === 'dnf-cache')!
  expect(await f.pool.exec(f.host.id, envCommand(cache.check.replaceAll('/var/cache/dnf', path.join(f.directory, 'absent-cache')).replaceAll('/etc/os-release', osRelease), {}))).toMatchObject({ code: 0, stdout: 'bytes=0\ndnf cache: 0 bytes\n' })
  expect(await f.pool.exec(f.host.id, 'printf still-open')).toMatchObject({ stdout: 'still-open' })
})
it('keeps partial du results on SSH timeout and enforces the output byte cap', async () => {
  const f = await setup()
  f.shim('du', '[ \"$*\" != \"-k -x -d 0 /dev/null\" ] || exit 0; printf "16\\t/fixture/a\\n8\\t/fixture/b\\n"; sleep 15')
  const result = await f.pool.exec(f.host.id, cleanupDuCommand('/fixture'), { timeoutMs: 5_000, maxOutputBytes: 256 * 1024 })
  expect(result.timedOut).toBe(true); expect(cleanupDuOutput(result.stdout)).toContain('/fixture/a')
  f.shim('du', '[ \"$*\" != \"-k -x -d 0 /dev/null\" ] || exit 0; awk \'BEGIN {for(i=0;i<30000;i++) print "1024 /fixture/a"}\'')
  const capped = await f.pool.exec(f.host.id, cleanupDuCommand('/fixture'), { maxOutputBytes: 256 * 1024 })
  expect(capped.truncated).toBe(true); expect(Buffer.byteLength(capped.stdout)).toBe(256 * 1024)
})
it.each(['old', 'running', 'latest', 'other'])('kernel simulation %s is checked read-only and protected packages are rejected', async (removal) => {
  const f = await setup(), osRelease = path.join(f.directory, 'os-release')
  fs.writeFileSync(osRelease, 'ID=debian\n')
  f.shim('uname', 'echo 6.1.0-2-amd64')
  f.shim('dpkg-query', 'printf "installed linux-image-6.1.0-1-amd64 10\\ninstalled linux-image-6.1.0-2-amd64 20\\ninstalled linux-image-6.1.0-3-amd64 30\\n"')
  const pkg = { old: 'linux-image-6.1.0-1-amd64', running: 'linux-image-6.1.0-2-amd64', latest: 'linux-image-6.1.0-3-amd64', other: 'business-service' }[removal]
  f.shim('apt-get', `[ "$*" = '-s autoremove --purge' ] || exit 90\nprintf 'Remv ${pkg} [1.0]\\n'`)
  const step = cleanupRunbook.steps.find((step) => step.id === 'old-kernels')!
  const result = await f.pool.exec(f.host.id, envCommand(step.check.replaceAll('/etc/os-release', osRelease), {}))
  expect(result.code, result.stderr).toBe(removal === 'old' ? 10 : 20)
  expect(parseCleanup(result.stdout).bytes).toBe(removal === 'old' ? 10240 : null)
})
