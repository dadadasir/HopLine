import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startMiniSshd } from './support/mini-sshd.mjs'
import { generateAgentKey, startMiniAgent } from './support/mini-agent.mjs'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'
import { loginAsNewUser, listInitIdentities } from '../src/main/init-gates'
import { envCommand, RunbookEngine } from '../src/core/runbook/engine'
import type { InitAuth } from '../src/shared/types'
import type { Runbook } from '../src/core/runbook/types'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; vi.unstubAllEnvs() })
async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-init-live-'))
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  const key = generateAgentKey(), wrong = generateAgentKey(), privateKeyPath = path.join(directory, 'key'), publicPath = `${privateKeyPath}.pub`
  fs.writeFileSync(privateKeyPath, key.private); fs.writeFileSync(publicPath, key.public)
  fs.writeFileSync(path.join(directory, 'wrong'), wrong.private)
  // These shims operate only on files inside the mini-sshd temporary root, never on the local OS.
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh
[ "$1" = '-n' ] && { shift; [ "$1" = true ] && exit 1; exec "$@"; }
IFS= read -r pw
printf '%s' "$pw" > sudo-input
[ "$pw" = 'new-password' ] || exit 1
shift 3
[ "$1" = '-v' ] && exit 0
exec "$@"
`, { mode: 0o700 })
  fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\nprintf 1000', { mode: 0o700 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  const server = await startMiniSshd({ username: 'newadmin', password: 'old-password', publicKey: publicPath })
  cleanups.push(() => server.close())
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const host = vault.saveHost({ groupId: null, name: 'loopback', host: '127.0.0.1', port: server.port, username: 'newadmin', authType: 'password', password: 'old-password' })
  const trusted = new Map<string, string>()
  const pool = new ConnectionPool(vault, { verifyHost: async (check) => { trusted.set(`${check.host}:${check.port}`, check.fingerprint); return true }, onKeyboard: async () => null })
  cleanups.push(() => pool.closeAll())
  const lease = await pool.acquire(host.id)
  cleanups.push(() => lease.release())
  return { directory, key, wrong, privateKeyPath, server, vault, host, pool, trusted,
    params: { USER: 'newadmin', PUBKEY: key.public.trim(), USER_PASSWORD: 'new-password' },
    verifyHost: async (check: { host: string; port: number; fingerprint: string }) => trusted.get(`${check.host}:${check.port}`) === check.fingerprint }
}
it.each(['privateKey', 'agent'] as const)('uses a fresh %s connection with trusted fingerprint and stdin sudo, preserving the current connection', async (type) => {
  const f = await setup(), auth: InitAuth = { type, privateKeyPath: f.privateKeyPath }
  if (type === 'agent') {
    const agent = await startMiniAgent([f.wrong.private, f.key.private]); cleanups.push(() => agent.close()); auth.socket = agent.socket
    vi.stubEnv('SSH_AUTH_SOCK', agent.socket)
    expect((await listInitIdentities()).filter((identity) => identity.auth.type === 'agent').map((identity) => identity.publicKey)).toContain(f.params.PUBKEY.split(' ').slice(0, 2).join(' '))
  }
  const before = f.server.acceptedConnections
  expect(await loginAsNewUser(f.vault, f.host.id, auth, f.params, f.verifyHost)).toEqual({ ok: true })
  expect(f.server.acceptedConnections).toBe(before + 1)
  expect(fs.readFileSync(path.join(f.server.root, 'sudo-input'), 'utf8')).toBe('new-password')
  await vi.waitFor(() => expect(f.server.activeConnections).toBe(1))
  expect(await f.pool.exec(f.host.id, 'printf original-open')).toMatchObject({ code: 0, stdout: 'original-open' })
  expect(f.server.acceptedConnections).toBe(before + 1)
})
it.each(['wrong-key', 'wrong-password', 'untrusted'] as const)('rejects %s, closes the extra connection, and retains current password login', async (failure) => {
  const f = await setup()
  const result = await loginAsNewUser(f.vault, f.host.id, { type: 'privateKey', privateKeyPath: failure === 'wrong-key' ? path.join(f.directory, 'wrong') : f.privateKeyPath },
    { ...f.params, USER_PASSWORD: failure === 'wrong-password' ? 'incorrect' : f.params.USER_PASSWORD }, failure === 'untrusted' ? async () => false : f.verifyHost)
  expect(result).toEqual({ ok: false, reason: failure === 'wrong-password' ? 'init.sudoFailed' : 'init.loginFailed' })
  await vi.waitFor(() => expect(f.server.activeConnections).toBe(1))
  expect(await f.pool.exec(f.host.id, 'printf still-open')).toMatchObject({ code: 0, stdout: 'still-open' })
  const newLease = await f.pool.acquire(f.host.id, { fresh: true }); newLease.release()
})
it.each([false, true])('separates existing and new-user stdin with cached sudo=%s', async (cached) => {
  const f = await setup(), commands: string[] = [], password = "new-user-$(literal)'password"
  if (cached) fs.writeFileSync(path.join(f.directory, 'bin', 'sudo'), `#!/bin/sh
[ "$1" = '-n' ] && exit 1
shift 3
if [ "$1" = '-v' ]; then IFS= read -r pw; [ "$pw" = 'new-password' ]; exit $?; fi
exec "$@"
`, { mode: 0o700 })
  const book: Runbook = { id: 'stdin', title: 'stdin', params: [{ name: 'PW', label: 'password', pattern: '.+', secret: true }], steps: [{
    id: 'file', title: 'file', sudo: true, stdin: 'PW', check: '[ -f new-user-input ] && exit 0; exit 10',
    apply: 'IFS= read -r value; printf %s "$value" > new-user-input', verify: '[ -s new-user-input ]'
  }] }
  const engine = new RunbookEngine((script, { stdin, env }) => {
    const command = envCommand(script, env); commands.push(command)
    return f.pool.exec(f.host.id, command, { stdin })
  })
  await engine.plan(book, { PW: password })
  expect(await engine.run(book, { PW: password }, ['file'], { sudoPassword: 'new-password' })).toMatchObject({ executed: 1 })
  expect(fs.readFileSync(path.join(f.server.root, 'new-user-input'), 'utf8')).toBe(password)
  expect(commands.join('\n')).not.toContain(password)
  expect(commands.join('\n')).not.toContain('new-password')
})
