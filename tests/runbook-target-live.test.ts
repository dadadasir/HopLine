import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'
import { RunbookService } from '../src/main/runbook-service'
import { execReadOnly } from '../src/main/ssh/read-only-exec'
import { OpLog } from '../src/main/oplog'

const { Server, utils } = createRequire(import.meta.url)('ssh2')
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let key: string
function hostKey(): string {
  if (key) return key
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = utils.generateKeyPairSync('ed25519').private
    if (!(utils.parseKey(candidate) instanceof Error)) return key = candidate
  }
  throw new Error('test host key generation failed')
}
async function sshFixture() {
  const clients = new Set<any>(), commands: Array<{ command: string; stdin: string }> = []
  let connections = 0
  const hooks: { reply?: (command: string) => Promise<void> } = {}
  const server = new Server({ hostKeys: [hostKey()] }, (client: any) => {
    connections++; clients.add(client); client.setNoDelay(true)
    client.on('error', () => {}); client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx: any) => ctx.method === 'password' && ctx.password === 'fake-ssh-password' ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', (accept: any) => {
      const session = accept()
      session.on('exec', (acceptExec: any, _reject: unknown, info: { command: string }) => {
        // Pure response fixtures: never execute cleanup scripts on the local machine.
        const stream = acceptExec(), row = { command: info.command, stdin: '' }; commands.push(row)
        stream.on('error', () => {}); stream.on('data', (chunk: Buffer) => { row.stdin += chunk.toString() })
        stream.on('end', async () => {
          await hooks.reply?.(info.command)
          let code = 0, stdout = ''
          if (info.command.includes('# cleanup:verify')) stdout = 'bytes=0\n'
          else if (info.command.includes('# cleanup:')) { code = 10; stdout = 'bytes=4096\n' }
          else if (info.command.includes('id -u')) stdout = '1000'
          else if (info.command.includes('sudo -n true')) code = 1
          stream.write(stdout); stream.exit(code); stream.end()
        })
      })
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(resolve)) })
  return { port: server.address().port as number, commands, hooks, connections: () => connections }
}
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-target-live-'))
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  const a = await sshFixture(), b = await sshFixture(), vault = new Vault(emptyStore(), new MemorySecretCodec())
  const host = vault.saveHost({ name: '测试目标', groupId: null, host: '127.0.0.1', port: a.port, username: 'user', authType: 'password', password: 'fake-ssh-password' })
  const verifyHost = vi.fn(async () => true), pool = new ConnectionPool(vault, { verifyHost, onKeyboard: async () => null })
  cleanups.push(() => pool.closeAll())
  const service = new RunbookService(pool, new OpLog(directory), id => !!vault.getHost(id), () => {})
  const change = () => { vault.saveHost({ ...vault.getHost(host.id)!, port: b.port }); pool.invalidate(host.id) }
  return { a, b, host, pool, service, verifyHost, change }
}

it('rejects a preview after a real loopback target edit before connecting or sending the saved sudo password elsewhere', async () => {
  const f = await fixture(), plan = await f.service.plan(f.host.id, 'cleanup', {}, {}, 'fake-sudo-password')
  const sent = f.a.commands.length
  f.change()
  await expect(f.service.run(f.host.id, plan.id, ['apt-cache'], 'fake-sudo-password')).rejects.toThrow('runbook.targetChanged')
  await expect(f.service.disk(f.host.id, '/')).rejects.toThrow('runbook.targetChanged')
  expect(f.a.commands).toHaveLength(sent); expect(f.b.connections()).toBe(0); expect(f.b.commands).toEqual([])
})

it('rejects a target edit while waiting on a real SSH handshake and sends no cleanup/password command', async () => {
  const f = await fixture(), plan = await f.service.plan(f.host.id, 'cleanup', {}, {}, 'fake-sudo-password')
  f.pool.invalidate(f.host.id)
  const waiting = deferred<void>(), accepted = deferred<boolean>()
  f.verifyHost.mockImplementationOnce(async () => { waiting.resolve(); return accepted.promise })
  const sent = f.a.commands.length, work = f.service.run(f.host.id, plan.id, ['apt-cache'], 'fake-sudo-password')
  const rejected = expect(work).rejects.toThrow('runbook.targetChanged')
  await waiting.promise; f.change(); accepted.resolve(true); await rejected
  expect(f.a.commands).toHaveLength(sent); expect(f.b.connections()).toBe(0)
})

it('keeps an in-flight cleanup on its original real connection and never dispatches another item to an edited target', async () => {
  const f = await fixture(), plan = await f.service.plan(f.host.id, 'cleanup', {}, {}, 'fake-sudo-password')
  const started = deferred<void>(), finish = deferred<void>()
  f.a.hooks.reply = async command => { if (command.includes('apt-get clean')) { started.resolve(); await finish.promise } }
  const work = f.service.run(f.host.id, plan.id, ['apt-cache', 'dnf-cache'], 'fake-sudo-password')
  const rejected = expect(work).rejects.toThrow('runbook.targetChanged')
  await started.promise; f.change(); finish.resolve(); await rejected
  expect(f.b.connections()).toBe(0); expect(f.b.commands).toEqual([])
  expect(f.a.commands.filter(row => row.command.includes('apt-get clean'))).toHaveLength(1)
  expect(f.a.commands.some(row => row.command.includes('clean packages'))).toBe(false)
  await expect(f.service.disk(f.host.id, '/')).rejects.toThrow('runbook.targetChanged')
})

it('checks read-only authorization after lease acquisition but before sending the supervised command or password', async () => {
  const f = await fixture(), beforeStart = vi.fn(() => { throw new Error('runbook.targetChanged') })
  await expect(execReadOnly(f.pool, f.host.id, 'printf must-not-run', { beforeStart, sudo: { mode: 'password', password: 'runbook' } })).rejects.toThrow('runbook.targetChanged')
  expect(beforeStart).toHaveBeenCalledOnce(); expect(f.a.connections()).toBe(1); expect(f.a.commands).toEqual([])
})
