import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { SessionHub } from '../src/main/sessions'
import { startMiniSshd } from './support/mini-sshd.mjs'
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))
let directory: string
let hub: SessionHub
let vault: Vault
let server: Awaited<ReturnType<typeof startMiniSshd>>
let hostId: string
const emit = vi.fn()
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-test-prompt-live-'))
  server = await startMiniSshd({ password: 'test', root: path.join(directory, 'server') })
  vault = new Vault(emptyStore(), new MemorySecretCodec())
  hostId = vault.saveHost({ groupId: null, name: 'test', host: '127.0.0.1', port: server.port,
    username: 'hop', authType: 'password', password: 'test' }).id
  hub = new SessionHub(vault, new KnownHostFile(path.join(directory, 'known.json')), emit, directory)
})
afterEach(async () => {
  await hub.closeAll()
  await hub.pool.closeAll()
  await server.close()
  fs.rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
  emit.mockClear()
})
async function prompt() {
  await vi.waitFor(() => expect(emit.mock.calls.some(([channel]) => channel === 'hostkey:prompt')).toBe(true))
  const payload = emit.mock.calls.find(([channel]) => channel === 'hostkey:prompt')![1]
  expect(payload).not.toHaveProperty('signal')
  return payload.requestId as string
}
it('expires authentication when its session closes and ignores late answers', async () => {
  const connection = hub.connect(hostId, 80, 24).catch(() => null)
  const requestId = await prompt()
  await hub.close(hub.list()[0].id)
  await connection
  expect(emit).toHaveBeenCalledWith('prompt:expired', { requestId })
  hub.respondHostKey(requestId, 'save')
  expect(fs.existsSync(path.join(directory, 'known.json'))).toBe(false)
  expect(hub.list()).toEqual([])
})
it('keeps a shared prompt until the final waiting session closes', async () => {
  const first = hub.connect(hostId, 80, 24).catch(() => null)
  const second = hub.connect(hostId, 80, 24).catch(() => null)
  const requestId = await prompt()
  await hub.close(hub.list()[0].id)
  await first
  expect(emit).not.toHaveBeenCalledWith('prompt:expired', expect.anything())
  await hub.close(hub.list()[0].id)
  await second
  expect(emit.mock.calls.filter(([name]) => name === 'prompt:expired')).toEqual([['prompt:expired', { requestId }]])
})
it('expires on remote disconnect, but never expires an answered request', async () => {
  const failed = hub.connect(hostId, 80, 24).catch(() => null)
  const requestId = await prompt()
  server.disconnectAll()
  await failed
  expect(emit).toHaveBeenCalledWith('prompt:expired', { requestId })
  emit.mockClear()
  const connected = hub.connect(hostId, 80, 24)
  const answered = await prompt()
  hub.respondHostKey(answered, 'once')
  const session = await connected
  await hub.close(session.id)
  await hub.pool.closeAll()
  expect(emit).not.toHaveBeenCalledWith('prompt:expired', expect.anything())
})

it('cancels a keyboard challenge when its session closes', async () => {
  const { Server, utils } = await import('ssh2')
  const clients = new Set<import('ssh2').Connection>()
  const keyboardServer = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      if (ctx.method === 'keyboard-interactive') ctx.prompt([{ prompt: 'OTP', echo: false }], () => ctx.reject())
      else ctx.reject(['keyboard-interactive'])
    })
  })
  await new Promise<void>((resolve) => keyboardServer.listen(0, '127.0.0.1', resolve))
  try {
    const port = (keyboardServer.address() as import('node:net').AddressInfo).port
    const host = vault.saveHost({ groupId: null, name: 'kbd', host: '127.0.0.1', port, username: 'hop', authType: 'keyboard-interactive' })
    const connected = hub.connect(host.id, 80, 24).catch(() => null)
    hub.respondHostKey(await prompt(), 'once')
    await vi.waitFor(() => expect(emit.mock.calls.some(([name]) => name === 'kbd:prompt')).toBe(true))
    const requestId = emit.mock.calls.find(([name]) => name === 'kbd:prompt')![1].requestId
    await hub.close(hub.list()[0].id)
    await connected
    expect(emit.mock.calls.filter(([name]) => name === 'prompt:expired')).toEqual([['prompt:expired', { requestId }]])
  } finally {
    for (const client of clients) client.end()
    await new Promise<void>((resolve) => keyboardServer.close(() => resolve()))
  }
})
