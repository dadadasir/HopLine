import { readFileSync } from 'node:fs'
import { beforeEach, expect, it } from 'vitest'
import { describeDistros } from './harness'
import { execSsh } from './ssh'
import { MemorySecretCodec, Vault, emptyStore } from '../../src/core/vault'
import { ConnectionPool } from '../../src/main/ssh/pool'
import { envCommand, RunbookEngine } from '../../src/core/runbook/engine'
import { timezoneRunbook } from '../../src/core/runbook/samples'
import type { StepResult } from '../../src/core/runbook/types'

// Minimal fixed-offset TZif fixtures for images without tzdata; no package install or network needed.
function zone(offset: number, abbreviation: string): string {
  const bytes = Buffer.alloc(50 + abbreviation.length + 1)
  bytes.write('TZif'); bytes.writeUInt32BE(1, 36); bytes.writeUInt32BE(abbreviation.length + 1, 40)
  bytes.writeInt32BE(offset, 44); bytes.write(abbreviation, 50)
  return bytes.toString('base64')
}
describeDistros(['ubuntu-24-systemd', 'alpine-3'], (target) => {
  beforeEach(async () => {
    const setup = `mkdir -p /usr/share/zoneinfo/Asia
[ -f /usr/share/zoneinfo/UTC ] || printf '%s' '${zone(0, 'UTC')}' | base64 -d > /usr/share/zoneinfo/UTC
[ -f /usr/share/zoneinfo/Asia/Shanghai ] || printf '%s' '${zone(28800, 'CST')}' | base64 -d > /usr/share/zoneinfo/Asia/Shanghai
if command -v timedatectl >/dev/null 2>&1; then timedatectl set-timezone UTC
else printf '%s\\n' UTC > /etc/timezone && ln -snf /usr/share/zoneinfo/UTC /etc/localtime; fi`
    expect(await execSsh(target(), target().users.root, setup)).toMatchObject({ code: 0 })
  })
  async function using(user: 'admin' | 'ops', action: (engine: RunbookEngine, results: StepResult[]) => Promise<void>) {
    const host = target(), vault = new Vault(emptyStore(), new MemorySecretCodec())
    const saved = vault.saveHost({ name: host.name, host: host.host, port: host.port, groupId: null,
      username: host.users[user], authType: 'privateKey', privateKey: readFileSync(host.keyPath, 'utf8') })
    const pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null }), results: StepResult[] = []
    const engine = new RunbookEngine((script, { env, stdin }) => pool.exec(saved.id, envCommand(script, env), { stdin }), (result) => results.push(result))
    try { await action(engine, results) } finally { await pool.closeAll() }
  }
  const params = { TZ: 'Asia/Shanghai' }, selection = ['timezone']
  it('admin password executes and verifies; repeating the run is already satisfied', async () => using('admin', async (engine, results) => {
    expect((await engine.plan(timezoneRunbook, params)).sudo).toBe('password')
    expect(await engine.run(timezoneRunbook, params, selection, { sudoPassword: target().adminPassword })).toMatchObject({ executed: 1 })
    expect((await engine.plan(timezoneRunbook, params)).steps[0].status).toBe('already')
    expect(await engine.run(timezoneRunbook, params, selection)).toMatchObject({ already: 1 })
    expect(JSON.stringify(results)).not.toContain(target().adminPassword)
  }))
  it('incorrect password rejects the whole run and leaves UTC unchanged', async () => using('admin', async (engine, results) => {
    await engine.plan(timezoneRunbook, params)
    await expect(engine.run(timezoneRunbook, params, selection, { sudoPassword: 'incorrect-password' })).rejects.toThrow('sudo 密码不正确')
    expect(results).toEqual([])
    expect(await execSsh(target(), target().users.root, envCommand(timezoneRunbook.steps[0].check, { HL_TZ: 'UTC' }))).toMatchObject({ code: 0 })
  }))
  it('ops executes through passwordless sudo', async () => using('ops', async (engine) => {
    expect((await engine.plan(timezoneRunbook, params)).sudo).toBe('nopass')
    expect(await engine.run(timezoneRunbook, params, selection)).toMatchObject({ executed: 1 })
  }))
  it('a failed verification rolls back and restores the original timezone', async () => using('admin', async (engine, results) => {
    const failing = structuredClone(timezoneRunbook); failing.steps[0].verify = 'exit 1'
    await engine.plan(failing, params)
    expect(await engine.run(failing, params, selection, { sudoPassword: target().adminPassword })).toMatchObject({ failed: 1 })
    expect(results[0]).toMatchObject({ rollback: true })
    expect(await execSsh(target(), target().users.root, envCommand(timezoneRunbook.steps[0].check, { HL_TZ: 'UTC' }))).toMatchObject({ code: 0 })
  }))
})
