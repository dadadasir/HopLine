import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { distroSkipReason, startDistro } from './harness'
import { MemorySecretCodec, Vault, emptyStore } from '../../src/core/vault'
import { ConnectionPool } from '../../src/main/ssh/pool'
import { RunbookService } from '../../src/main/runbook-service'
import { OpLog } from '../../src/main/oplog'
import { shellEscape } from '../../src/core/shell'
import { cleanupRunbook, type CleanupChange } from '../../src/core/runbook/cleanup'

// Every mutating command is confined to containers created by this harness.
describe.skipIf(Boolean(distroSkipReason()))('M2-H Docker cleanup', () => {
  it.each(['ubuntu-24-systemd', 'alpine-3'])('%s: release, verify, repeat, unavailable Docker and protected tmp files', async (name) => {
    const target = await startDistro(name), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-distro-'))
    const vault = new Vault(emptyStore(), new MemorySecretCodec()), host = vault.saveHost({ groupId: null, name, host: target.host, port: target.port, username: target.users.root, authType: 'privateKey', privateKeyPath: target.keyPath })
    const pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null })
    const changes: Record<string, CleanupChange> = {}, log = new OpLog(directory)
    const service = new RunbookService(pool, log, () => true, (event) => { if (event.cleanup) changes[event.result.stepId] = event.cleanup })
    const command = (script: string) => pool.exec(host.id, `sh -c ${shellEscape(script)}`, { timeoutMs: 600_000 })
    try {
      const alpine = name === 'alpine-3', cache = alpine ? 'apk-cache' : 'apt-cache'
      expect(await command(alpine ? 'apk add --no-cache psmisc' : 'apt-get update && apt-get install -y psmisc'), 'install occupancy checker in target only').toMatchObject({ code: 0 })
      expect(await command(`set -eu
mkdir -p /tmp/cleanup-fixture ${alpine ? '/var/cache/apk' : '/var/cache/apt/archives'}
${alpine ? '# Alpine only keeps a package cache once /etc/apk/cache points at it.\nln -sfn /var/cache/apk /etc/apk/cache\n' : ''}dd if=/dev/zero of=${alpine ? '/var/cache/apk/hopline-stale-1.0.deadbeef.apk' : '/var/cache/apt/archives/hopline-fake.deb'} bs=1024 count=64
printf old > /tmp/cleanup-fixture/old
printf recent > /tmp/cleanup-fixture/recent
printf held > /tmp/cleanup-fixture/held
touch -t 202001010000 /tmp/cleanup-fixture/old /tmp/cleanup-fixture/held
touch -t "$(date -d yesterday +%Y%m%d%H%M 2>/dev/null || date -d @$(($(date +%s)-86400)) +%Y%m%d%H%M)" /tmp/cleanup-fixture/recent
ln -s /tmp/cleanup-fixture/recent /tmp/cleanup-fixture/link
nohup sh -c 'exec 3</tmp/cleanup-fixture/held; sleep 600' >/dev/null 2>&1 &`)).toMatchObject({ code: 0 })
      const selected = [cache, 'tmp-old']
      if (!alpine) {
        // Make archived journals exceed the 200 MiB retention target without changing the host OS.
        expect(await command(`set -eu
mkdir -p /run/systemd/journald.conf.d
printf '[Journal]\\nStorage=volatile\\nRuntimeMaxUse=400M\\nRuntimeMaxFileSize=32M\\nRateLimitIntervalSec=0\\nCompress=no\\n' > /run/systemd/journald.conf.d/cleanup-test.conf
systemctl restart systemd-journald
awk 'BEGIN {s=sprintf("%08000d",0); for(i=0;i<34000;i++) print i, s}' | systemd-cat -t cleanup-fixture
journalctl --sync
journalctl --rotate`)).toMatchObject({ code: 0 })
        selected.push('journal')
      }
      const plan = await service.plan(host.id, 'cleanup', {})
      for (const id of selected) expect(plan.cleanup?.[id]?.bytes, `${id}: ${JSON.stringify(plan)}`).toBeGreaterThan(0)
      for (const step of cleanupRunbook.steps.filter((step) => step.id.startsWith('docker-'))) expect(plan.cleanup?.[step.id]?.unavailable).toBe(true)
      expect(await service.run(host.id, plan.id, selected), JSON.stringify(log.list(host.id))).toMatchObject({ executed: selected.length, failed: 0 })
      for (const id of selected) expect(changes[id].after).toBeLessThan(changes[id].before!)
      const again = await service.plan(host.id, 'cleanup', {})
      for (const id of selected) expect(again.steps.find((step) => step.id === id)?.status, JSON.stringify(again)).toBe('already')
      expect(await service.run(host.id, again.id, selected)).toMatchObject({ executed: 0, failed: 0 })
      expect(await command('test ! -e /tmp/cleanup-fixture/old && test -f /tmp/cleanup-fixture/recent && test -f /tmp/cleanup-fixture/held && test -L /tmp/cleanup-fixture/link')).toMatchObject({ code: 0 })
      const last = log.list(host.id).slice(-cleanupRunbook.steps.length)
      expect(last.filter((entry) => entry.stepId.startsWith('docker-')).every((entry) => entry.status === 'unavailable')).toBe(true)
    } finally { await pool.closeAll(); await target.stop(); fs.rmSync(directory, { recursive: true, force: true }) }
  }, 1_200_000)
})

// Fresh SSH exec channels have no shared terminal. The fixture disables sudo
// timestamps, so every privileged command must receive the password on stdin.
describe.skipIf(Boolean(distroSkipReason()))('M2-H2 password sudo cleanup', () => {
  it.each(['debian-12', 'alpine-3', 'rocky-9'])('%s: admin gets real estimates, cleans and verifies without a sudo ticket', async (name) => {
    const target = await startDistro(name), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-password-distro-'))
    const vault = new Vault(emptyStore(), new MemorySecretCodec())
    const common = { groupId: null, name, host: target.host, port: target.port, authType: 'privateKey' as const, privateKeyPath: target.keyPath }
    const root = vault.saveHost({ ...common, username: target.users.root }), admin = vault.saveHost({ ...common, username: target.users.admin })
    const pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null })
    const progress: unknown[] = [], log = new OpLog(directory), service = new RunbookService(pool, log, () => true, (event) => progress.push(event))
    const alpine = name === 'alpine-3', rocky = name === 'rocky-9'
    const cache = alpine ? 'apk-cache' : rocky ? 'dnf-cache' : 'apt-cache'
    const cacheDir = alpine ? '/var/cache/apk' : '/var/cache/apt/archives'
    const filename = alpine ? 'hopline-stale-1.0.deadbeef.apk' : rocky ? 'hopline-fake.rpm' : 'hopline-fake.deb'
    try {
      expect(await pool.exec(root.id, `sh -c ${shellEscape(`set -eu
export LC_ALL=C
# DNF only cleans directories belonging to configured repositories. Read its own
# cache path without downloading metadata; do not invent an orphan directory.
cache_dir=${rocky ? "$(python3 -c 'import dnf; base=dnf.Base(); base.read_all_repos(); print(next(iter(base.repos.iter_enabled())).pkgdir)')" : shellEscape(cacheDir)}
mkdir -p "$cache_dir"
${alpine ? 'ln -sfn /var/cache/apk /etc/apk/cache' : ':'}
dd if=/dev/zero of="$cache_dir/${filename}" bs=1024 count=64
printf '%s\\n' 'Defaults timestamp_timeout=0' > /etc/sudoers.d/hopline-no-ticket
chmod 440 /etc/sudoers.d/hopline-no-ticket` )}`)).toMatchObject({ code: 0 })
      expect(await service.sudo(admin.id)).toBe('password')
      const legacy = await service.plan(admin.id, 'cleanup', {})
      expect(legacy.cleanup?.[cache]?.bytes).toBeNull()
      await expect(service.plan(admin.id, 'cleanup', {}, {}, 'wrong-password')).rejects.toThrow('sudo 密码不正确')
      const rootPlan = await service.plan(root.id, 'cleanup', {}, {}, '')
      const plan = await service.plan(admin.id, 'cleanup', {}, {}, target.adminPassword)
      for (const item of cleanupRunbook.steps) {
        expect(plan.cleanup?.[item.id]?.bytes, `${item.id}: password sudo must match root`).toBe(rootPlan.cleanup?.[item.id]?.bytes)
        expect(plan.cleanup?.[item.id]?.unavailable).toBe(rootPlan.cleanup?.[item.id]?.unavailable)
      }
      expect(plan.cleanup?.[cache]?.bytes, JSON.stringify(plan)).toBeGreaterThanOrEqual(64 * 1024)
      expect(plan.steps.find((step) => step.id === cache)?.status).toBe('needed')
      for (const item of cleanupRunbook.steps.filter((step) => step.id.startsWith('docker-'))) expect(plan.cleanup?.[item.id]?.unavailable).toBe(true)
      expect(log.list(admin.id)).toEqual([])
      expect(await service.run(admin.id, plan.id, [cache], target.adminPassword), JSON.stringify(log.list(admin.id))).toMatchObject({ executed: 1, failed: 0 })
      const again = await service.plan(admin.id, 'cleanup', {}, {}, target.adminPassword)
      expect(again.cleanup?.[cache]?.bytes, JSON.stringify(again)).toBe(0)
      expect(again.steps.find((step) => step.id === cache)?.status).toBe('already')
      expect(await service.run(admin.id, again.id, [cache], target.adminPassword)).toMatchObject({ already: again.steps.filter((step) => step.status === 'already').length, executed: 0, failed: 0 })
      expect(log.list(admin.id).slice(-cleanupRunbook.steps.length).find((entry) => entry.stepId === cache)).toMatchObject({ status: 'already', reason: 'bytes=0', output: '' })
      expect(JSON.stringify({ plan, again, progress, log: log.list(admin.id) })).not.toContain(target.adminPassword)
      expect(fs.readFileSync(path.join(directory, `${admin.id}.jsonl`), 'utf8')).not.toContain(target.adminPassword)
    } finally { await pool.closeAll(); await target.stop(); fs.rmSync(directory, { recursive: true, force: true }) }
  }, 1_200_000)
})
