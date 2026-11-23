import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { Client, Server, utils, type ClientChannel } from 'ssh2'
import type { Lease } from '../src/main/ssh/pool'
import { execReadOnly } from '../src/main/ssh/read-only-exec'
import { cleanupRunbook } from '../src/core/runbook/cleanup'
import { envCommand } from '../src/core/runbook/engine'

async function captureCommand(script: string): Promise<string> {
  let captured = ''
  const client = new EventEmitter() as Client
  client.exec = ((command: string, callback: (error: Error | undefined, channel: ClientChannel) => void) => {
    captured = command
    const channel = new Duplex({ read() {}, write(_chunk, _encoding, done) { done() } }) as ClientChannel
    Object.assign(channel, { stderr: new PassThrough(), close: () => channel.emit('close') })
    callback(undefined, channel)
    queueMicrotask(() => {
      const marker = /hopline-readonly-[a-f0-9]+/.exec(command)![0]
      channel.emit('data', Buffer.from(`${marker} unavailable\n`)); channel.emit('exit', 125); channel.emit('close')
    })
  }) as Client['exec']
  const lease: Lease = { hostId: 'fixture', client, onDrop: () => () => {}, release() {} }
  await execReadOnly({ acquire: async () => lease }, 'fixture', script, { sudo: { mode: 'nopass' } }).catch(() => {})
  return captured
}

it.each(cleanupRunbook.steps)('keeps the fully supervised privileged $id check below one SSH request packet', async (step) => {
  const command = await captureCommand(envCommand(step.check, {}))
  // ssh2's encrypted protocol rejects packets >35,000 bytes. Keep room for the
  // channel request envelope, padding and MAC; do not change that transport limit.
  expect(Buffer.byteLength(command)).toBeLessThan(32 * 1024)
})


it('transmits fixed-file and Docker log checks through encrypted loopback SSH without executing them', async () => {
  const errors: string[] = [], lengths: number[] = [], validInputs: boolean[] = []
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (connection) => {
    connection.on('error', (error) => errors.push(error.message))
    connection.on('authentication', (ctx) => ctx.username === 'fixture' && ctx.method === 'password' && ctx.password === 'ssh-fixture' ? ctx.accept() : ctx.reject())
    connection.on('ready', () => connection.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, _reject, info) => {
        lengths.push(Buffer.byteLength(info.command))
        const channel = acceptExec(), marker = /hopline-readonly-[a-f0-9]+/.exec(info.command)![0]
        let input = ''
        channel.on('data', (chunk: Buffer) => { input += chunk.toString() })
        channel.on('end', () => {
          validInputs.push(input === 'stdin-fixture\n'); input = ''
          // Transport-only fixture: never execute a cleanup command on this Mac.
          channel.write(`${marker} unavailable\n`); channel.exit(125); channel.end()
        })
      })
    }))
  })
  const client = new Client()
  client.on('error', (error) => errors.push(error.message))
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || !address) throw new Error('missing loopback address')
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve); client.once('error', reject)
      client.connect({ host: '127.0.0.1', port: address.port, username: 'fixture', password: 'ssh-fixture', hostVerifier: () => true })
    })
    const lease: Lease = { hostId: 'fixture', client, onDrop: () => () => {}, release() {} }
    for (const step of cleanupRunbook.steps.filter((item) => ['rotated-logs', 'crash-reports', 'coredumps', 'docker-container-logs'].includes(item.id))) {
      await expect(execReadOnly({ acquire: async () => lease }, 'fixture', envCommand(step.check, {}), { sudo: { mode: 'password', password: 'stdin-fixture' } })).rejects.toThrow('cleanup.readOnlyUnavailable')
    }
    expect(lengths).toHaveLength(4); expect(lengths.every((length) => length < 32 * 1024)).toBe(true)
    expect(validInputs).toEqual([true, true, true, true]); expect(errors).toEqual([])
  } finally {
    client.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
