import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { getEditionCapabilities } from '../src/ext/capabilities'
import { parseCollect } from '../src/core/collect/parse'
import { CollectService } from '../src/main/collect-service'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { ConnectionPool, type Lease } from '../src/main/ssh/pool'
import { startMiniSshd } from './support/mini-sshd.mjs'

it('skips the connected sixth host automatically but allows its manual collection over loopback SSH', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-overview-limit-'))
  const serverRoot = path.join(directory, 'server')
  const server = await startMiniSshd({ username: 'overview-fixture', password: 'fixture-only', root: serverRoot })
  fs.writeFileSync(path.join(serverRoot, 'snapshot.txt'), '===HOPLINE:uptime===\n42 0\n\n#HOPLINE-END\n')
  let service: CollectService | undefined
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  for (const name of ['01-first', '02-second', '03-third', '04-fourth', '05-fifth', '06-sixth']) {
    vault.saveHost({ name, groupId: null, host: '127.0.0.1', port: server.port, username: 'overview-fixture', authType: 'password', password: 'fixture-only' })
  }
  const hosts = vault.listHosts(), sixthId = hosts[5].id
  const pool = new ConnectionPool(vault, { idleMs: 150, verifyHost: vi.fn(async () => true), verifyHostWithoutPrompt: async () => true, onKeyboard: async () => null })
  let held: Lease | undefined
  try {
    // The sixth host is already connected, so a filter-then-slice regression
    // would incorrectly collect it to fill the five disconnected slots.
    held = await pool.acquire(sixthId)
    const acquire = vi.spyOn(pool, 'acquire')
    service = new CollectService({
      overviewHostLimit: getEditionCapabilities('community').overviewHostLimit,
      pool, hosts: () => vault.listHosts(), filePath: path.join(directory, 'snapshots.json'), updated: vi.fn(),
      collect: async (executor, hostId) => {
        const result = await executor.exec(hostId, 'cat snapshot.txt', { timeoutMs: 5000, maxOutputBytes: 1024 })
        if (result.code !== 0 || result.signal || result.timedOut || result.truncated) throw new Error('测试快照采集失败')
        return parseCollect(result.stdout, Date.now())
      }
    })
    service.setOverviewOpen(true)
    service.setWindowOpen(true)
    await vi.waitFor(() => expect(Object.values(service!.latest()).filter(row => row.snapshot)).toHaveLength(5), { timeout: 5000 })
    expect(acquire.mock.calls).toEqual(hosts.slice(0, 5).map(host => [host.id, { interaction: 'forbid', signal: expect.any(AbortSignal) }]))
    expect(service.latest()[sixthId]).toBeUndefined()
    const connections = server.acceptedConnections
    await new Promise(resolve => setTimeout(resolve, 225))
    for (const host of hosts.slice(0, 5)) expect(pool.isOpen(host.id)).toBe(true)
    await service.runConnected(hosts[0].id)
    expect(server.acceptedConnections).toBe(connections)
    service.setWindowOpen(false)
    await vi.waitFor(() => expect(pool.isOpen(hosts[0].id)).toBe(false), { timeout: 5000 })
    acquire.mockClear()
    const sixth = await service.run(sixthId)
    expect(sixth.error).toBe(null)
    expect(sixth.snapshot?.uptime).toEqual({ status: 'complete', data: { seconds: 42 } })
    expect(acquire).toHaveBeenCalledExactlyOnceWith(sixthId, { signal: expect.any(AbortSignal) })
    expect(service.latest()[sixthId]).toEqual(sixth)
  } finally {
    service?.stop(); held?.release(); await pool.closeAll(); vi.restoreAllMocks()
    await server.close(); fs.rmSync(directory, { recursive: true, force: true })
  }
})
