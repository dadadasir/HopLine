import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { connectEndpoint, type Endpoint, type HostCheck, type OpenedConnection } from '../src/main/ssh/connect'
import { execOnClient } from '../src/main/ssh/exec'
import { ConnectionPool } from '../src/main/ssh/pool'
import { startMiniSshd } from './support/mini-sshd.mjs'

// Run outside the sandbox: these tests require real loopback listeners.
describe('two jumps and a target with mini-sshd', () => {
  let directory: string
  let servers: Awaited<ReturnType<typeof startMiniSshd>>[]
  let opened: OpenedConnection | undefined
  let pool: ConnectionPool | undefined
  let endpoints: Endpoint[]
  const verifyHost = vi.fn(async (_check: HostCheck) => true)
  const options = { verifyHost, onKeyboard: async () => null }

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-chain-live-'))
    servers = []
    verifyHost.mockClear()
    for (let index = 0; index < 3; index++) {
      servers.push(await startMiniSshd({ username: `user${index}`, password: `secret${index}`, root: path.join(directory, String(index)) }))
    }
    endpoints = servers.map((server, index) => ({
      host: '127.0.0.1', port: server.port, username: server.username,
      auth: { authType: 'password', password: `secret${index}`, privateKey: null, privateKeyPath: null, passphrase: null }
    }))
  })

  afterEach(async () => {
    await pool?.closeAll()
    opened?.client.end()
    for (const jump of [...(opened?.jumps ?? [])].reverse()) jump.end()
    for (const server of [...servers].reverse()) await server.close()
    opened = undefined
    pool = undefined
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('executes through both jumps and verifies each endpoint in order', async () => {
    opened = await connectEndpoint(endpoints[2]!, { ...options, jumps: endpoints.slice(0, 2) })
    expect(opened.jumps).toHaveLength(2)
    expect(await execOnClient(opened.client, 'printf chain-ok')).toMatchObject({ code: 0, stdout: 'chain-ok' })
    expect(verifyHost.mock.calls.map(([check]) => check)).toEqual(endpoints.map(({ host, port }) => expect.objectContaining({ host, port })))
    expect(servers.map((server) => server.activeConnections)).toEqual([1, 1, 1])
  })

  it('identifies jump 2 authentication failure and closes jump 1', async () => {
    endpoints[1]!.auth.password = 'wrong'
    await expect(connectEndpoint(endpoints[2]!, { ...options, jumps: endpoints.slice(0, 2) })).rejects.toThrow(
      `跳板 2（127.0.0.1:${servers[1]!.port}）：认证失败，请检查用户名、密码或私钥`
    )
    expect(servers[0]!.acceptedConnections).toBe(1)
    expect(servers[1]!.acceptedConnections).toBe(1)
    expect(servers[2]!.acceptedConnections).toBe(0)
    await vi.waitFor(() => expect(servers.map((server) => server.activeConnections)).toEqual([0, 0, 0]))
  })

  it('invalidates the pool after the intermediate server disconnects and reconnects the whole chain', async () => {
    const vault = new Vault(emptyStore(), new MemorySecretCodec())
    const target = endpoints[2]!
    const host = vault.saveHost({ name: 'chain', groupId: null, host: target.host, port: target.port, username: target.username, ...target.auth,
      jumps: endpoints.slice(0, 2).map(({ host, port, username, auth }) => ({ host, port, username, ...auth })) })
    pool = new ConnectionPool(vault, options)
    const lease = await pool.acquire(host.id)
    const drop = vi.fn()
    lease.onDrop(drop)
    servers[1]!.disconnectAll()
    await vi.waitFor(() => expect(drop).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(servers.map((server) => server.activeConnections)).toEqual([0, 0, 0]))
    const next = await pool.acquire(host.id)
    expect(next.client).not.toBe(lease.client)
    expect(await execOnClient(next.client, 'printf reconnected')).toMatchObject({ code: 0, stdout: 'reconnected' })
    expect(servers.map((server) => server.acceptedConnections)).toEqual([2, 2, 2])
    lease.release()
    next.release()
    await pool.closeAll()
    await vi.waitFor(() => expect(servers.map((server) => server.activeConnections)).toEqual([0, 0, 0]))
  })
})
