import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { startMiniSshd } from './support/mini-sshd.mjs'
import { ConnectionPool } from '../src/main/ssh/pool'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { envCommand, RunbookEngine } from '../src/core/runbook/engine'
import { shellEscape } from '../src/core/shell'
import { OpLog } from '../src/main/oplog'
import type { Runbook, StepResult } from '../src/core/runbook/types'

it('runs check/apply/verify and rollback over mini-sshd using the real pool and env adapter', async () => {
  const server = await startMiniSshd({ password: 'ssh-password' })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-runbook-live-'))
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const host = vault.saveHost({ name: 'mini', host: '127.0.0.1', port: server.port, username: server.username, authType: 'password', password: 'ssh-password', groupId: null })
  const pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null })
  const results: StepResult[] = [], log = new OpLog(directory)
  const value = "literal 'quotes' $(touch injected)\n$HOME; end"
  const book: Runbook = { id: 'file', title: 'file', params: [{ name: 'VALUE', label: 'value', pattern: '^[\\s\\S]+$', secret: true }], steps: [{
    id: 'write', title: 'write', sudo: false,
    check: '[ -f applied ] && exit 0; exit 10', apply: 'printf %s "$HL_VALUE" > applied',
    verify: '[ "$(cat applied)" = "$HL_VALUE" ]', rollback: 'rm -f applied'
  }] }
  const engine = new RunbookEngine((script, { env, stdin }) => pool.exec(host.id, envCommand(script, env), { stdin }), (result) => {
    results.push(result); log.append(host.id, { ...result, at: Date.now(), runbookId: book.id })
  })
  try {
    await engine.plan(book, { VALUE: value })
    expect(await engine.run(book, { VALUE: value }, ['write'])).toMatchObject({ executed: 1 })
    expect(fs.readFileSync(path.join(server.root, 'applied'), 'utf8')).toBe(value)
    expect(fs.existsSync(path.join(server.root, 'injected'))).toBe(false)
    await engine.plan(book, { VALUE: value })
    expect(await engine.run(book, { VALUE: value }, ['write'])).toMatchObject({ already: 1 })
    fs.rmSync(path.join(server.root, 'applied'))
    book.steps[0].verify = 'printf %s "$HL_VALUE"; exit 1'
    await engine.plan(book, { VALUE: value })
    expect(await engine.run(book, { VALUE: value }, ['write'])).toMatchObject({ failed: 1 })
    expect(results.at(-1)?.rollback).toBe(true)
    expect(fs.existsSync(path.join(server.root, 'applied'))).toBe(false)
    expect(JSON.stringify(log.list(host.id))).not.toContain(value)
    expect(results.at(-1)?.output).toContain('***')
  } finally { await pool.closeAll(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})

it('passes parameters through a sudo-like environment reset without putting the password in a command', async () => {
  const server = await startMiniSshd({ password: 'ssh-password' })
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const host = vault.saveHost({ name: 'sudo-mini', host: '127.0.0.1', port: server.port, username: server.username, authType: 'password', password: 'ssh-password', groupId: null })
  const pool = new ConnectionPool(vault, { verifyHost: async () => true, onKeyboard: async () => null })
  // Local shims never escalate privileges or touch the real machine's timezone.
  const bin = path.join(server.root, 'bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\nprintf 1000', { mode: 0o700 })
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/sh
[ "$1" = '-n' ] && exit 1
IFS= read -r password
[ "$password" = 'sudo-test-password' ] || exit 1
shift 3
[ "$1" = '-v' ] && exit 0
exec env -i PATH=/usr/bin:/bin "$@"
`, { mode: 0o700 })
  const commands: string[] = [], results: StepResult[] = []
  const book: Runbook = { id: 'sudo-env', title: 'sudo-env', params: [{ name: 'VALUE', label: 'value', pattern: '.+' }], steps: [{
    id: 'file', title: 'file', sudo: true, check: 'exit 10', apply: 'printf %s "$HL_VALUE" > sudo-result', verify: '[ "$(cat sudo-result)" = "$HL_VALUE" ]'
  }] }
  const engine = new RunbookEngine((script, { env, stdin }) => {
    const command = `PATH=${shellEscape(`${bin}:/usr/bin:/bin`)} ${envCommand(script, env)}`
    commands.push(command); return pool.exec(host.id, command, { stdin })
  }, (result) => results.push(result))
  try {
    expect((await engine.plan(book, { VALUE: "safe'quoted" })).sudo).toBe('password')
    expect(await engine.run(book, { VALUE: "safe'quoted" }, ['file'], { sudoPassword: 'sudo-test-password' })).toMatchObject({ executed: 1 })
    expect(fs.readFileSync(path.join(server.root, 'sudo-result'), 'utf8')).toBe("safe'quoted")
    expect(commands.join('\n')).not.toContain('sudo-test-password')
    expect(JSON.stringify(results)).not.toContain('sudo-test-password')
  } finally { await pool.closeAll(); await server.close() }
})
