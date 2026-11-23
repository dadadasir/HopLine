import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { distroSkipReason, startDistro } from './harness'
import { execSsh } from './ssh'
import { generateAgentKey } from '../support/mini-agent.mjs'
import { MemorySecretCodec, Vault, emptyStore } from '../../src/core/vault'
import { initRunbook } from '../../src/core/runbook/init'
import { ConnectionPool } from '../../src/main/ssh/pool'
import { execOnClient } from '../../src/main/ssh/exec'
import { loginAsNewUser } from '../../src/main/init-gates'
import { RunbookService } from '../../src/main/runbook-service'
import { OpLog } from '../../src/main/oplog'
import type { Params } from '../../src/core/runbook/types'

// Destructive commands are reachable only through targets created by this Docker harness.
describe.skipIf(Boolean(distroSkipReason()))('M2-C Docker initialization', () => {
  async function using(name: string, user: 'root' | 'admin', action: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    const f = await fixture(name, user)
    try { await action(f) } finally { f.lease.release(); await f.pool.closeAll(); await f.target.stop(); fs.rmSync(f.directory, { recursive: true, force: true }) }
  }
  async function fixture(name: string, user: 'root' | 'admin') {
    const target = await startDistro(name), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'init-distro-'))
    const vault = new Vault(emptyStore(), new MemorySecretCodec()), trusted = new Map<string, string>()
    const host = vault.saveHost({ groupId: null, name, host: target.host, port: target.port, username: target.users[user], authType: 'privateKey', privateKeyPath: target.keyPath })
    const pool = new ConnectionPool(vault, { verifyHost: async (check) => { trusted.set(`${check.host}:${check.port}`, check.fingerprint); return true }, onKeyboard: async () => null })
    try {
      const lease = await pool.acquire(host.id), log = new OpLog(directory)
      const service = new RunbookService(pool, log, (id) => !!vault.getHost(id), () => {})
      const params: Params = { USER: 'initadmin', PUBKEY: fs.readFileSync(`${target.keyPath}.pub`, 'utf8').trim(), USER_PASSWORD: 'Init-docker-test-2026', SWAP_MB: '256', TZ: 'UTC' }
      const gates = { 'login-as-new-user': (values: Params) => loginAsNewUser(vault, host.id, { type: 'privateKey', privateKeyPath: target.keyPath }, values,
        async (check) => trusted.get(`${check.host}:${check.port}`) === check.fingerprint) }
      const run = async (selected = initRunbook.steps.map((step) => step.id)) => {
        const preview = await service.plan(host.id, 'init', params, gates)
        return service.run(host.id, preview.id, selected, user === 'admin' ? target.adminPassword : undefined)
      }
      // Use the retained original connection even after root login has been disabled.
      const command = (script: string) => execOnClient(lease.client, user === 'root' ? script : `sudo -S -p '' sh -c ${quote(script)}`, { stdin: user === 'admin' ? `${target.adminPassword}\n` : undefined, timeoutMs: 600_000 })
      return { target, directory, vault, host, pool, lease, log, service, params, gates, run, command }
    } catch (error) { await pool.closeAll(); await target.stop(); fs.rmSync(directory, { recursive: true, force: true }); throw error }
  }
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
  it.each(['root', 'admin'] as const)('%s: all steps, fresh key login, password lockout, firewall, swap, and idempotence', async (user) => {
    await using('ubuntu-24-systemd', user, async (f) => {
      const summary = await f.run()
      expect(summary, JSON.stringify(f.log.list(f.host.id))).toMatchObject({ failed: 0, skipped: 0, unavailable: 0 })
      expect(summary.executed + summary.already).toBe(9)
      expect(await execSsh(f.target, f.params.USER, 'id -un')).toMatchObject({ code: 0, stdout: `${f.params.USER}\n` })
      await expect(execSsh(f.target, 'root', 'true', '', f.target.adminPassword)).rejects.toThrow()
      expect(await f.command("ufw status | grep -q 'Status: active' && ufw status | grep -E '^22/tcp[[:space:]].*ALLOW' && test \"$(wc -l < /proc/swaps)\" -gt 1")).toMatchObject({ code: 0 })
      expect(await f.run()).toEqual({ already: 9, executed: 0, failed: 0, skipped: 0, unavailable: 0 })
      expect(await f.command('printf connection-kept')).toMatchObject({ stdout: 'connection-kept' })
      expect(JSON.stringify(f.log.list(f.host.id))).not.toContain(f.params.USER_PASSWORD)
    })
  }, 1_200_000)
  it.each(['root', 'admin'] as const)('%s: mismatched deployed key skips both SSH changes and keeps root password login', async (user) => {
    await using('ubuntu-24-systemd', user, async (f) => {
      f.params.PUBKEY = generateAgentKey().public.trim()
      expect(await f.run(['create-user', 'deploy-key', 'ssh-disable-password', 'ssh-disable-root'])).toMatchObject({ failed: 0 })
      for (const id of ['ssh-disable-password', 'ssh-disable-root']) expect(f.log.list(f.host.id).find((entry) => entry.stepId === id)).toMatchObject({ status: 'skipped', reason: 'init.loginFailed', gate: { ok: false } })
      expect(await execSsh(f.target, 'root', 'printf password-kept', '', f.target.adminPassword)).toMatchObject({ stdout: 'password-kept' })
      expect(await f.command('printf connection-kept')).toMatchObject({ stdout: 'connection-kept' })
    })
  }, 1_200_000)
  it.each(['root', 'admin'] as const)('%s: invalid sshd fragment fails safely, restores files, and leaves both current and password connections working', async (user) => {
    await using('ubuntu-24-systemd', user, async (f) => {
      expect(await f.command("mkdir -p /etc/ssh/sshd_config.d; printf '\\nInclude /etc/ssh/sshd_config.d/*.conf\\n' >> /etc/ssh/sshd_config; printf 'InvalidHoplineOption yes\\n' > /etc/ssh/sshd_config.d/99-invalid.conf")).toMatchObject({ code: 0 })
      const before = await f.command('cat /etc/ssh/sshd_config')
      expect(await f.run(['create-user', 'deploy-key', 'ssh-disable-password'])).toMatchObject({ failed: 1 })
      expect(f.log.list(f.host.id).find((entry) => entry.stepId === 'ssh-disable-password')).toMatchObject({ status: 'failed', gate: { ok: true } })
      expect(await f.command('cat /etc/ssh/sshd_config')).toMatchObject({ code: 0, stdout: before.stdout })
      expect(await f.command('test ! -e /etc/ssh/sshd_config.d/10-hopline.conf && systemctl is-active --quiet ssh')).toMatchObject({ code: 0 })
      expect(await execSsh(f.target, 'root', 'printf password-kept', '', f.target.adminPassword)).toMatchObject({ stdout: 'password-kept' })
    })
  }, 1_200_000)
  it('Alpine: firewall is unavailable and never installed', async () => using('alpine-3', 'root', async (f) => {
    expect(await f.run(['firewall'])).toMatchObject({ unavailable: 1, failed: 0 })
    expect(f.log.list(f.host.id).find((entry) => entry.stepId === 'firewall')).toMatchObject({ status: 'unavailable', reason: 'init.noFirewall' })
    expect(await f.command('! command -v ufw && ! command -v firewall-cmd')).toMatchObject({ code: 0 })
  }), 1_200_000)
})
