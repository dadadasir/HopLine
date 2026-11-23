import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { parseCollect } from '../src/core/collect/parse'
import { CollectService } from '../src/main/collect-service'
import type { collectHost } from '../src/main/collect'
import { ConnectionPool } from '../src/main/ssh/pool'
import { startMiniSshd } from './support/mini-sshd.mjs'

vi.mock('../src/main/logger', () => ({ logError: vi.fn() }))

it('shares real loopback sampling and reports a later refused connection without reusing stale data as success', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-background-collect-'))
  const server = await startMiniSshd({ password: 'temporary-password', root: path.join(directory, 'server') })
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const host = vault.saveHost({ groupId: null, name: '回环测试', host: '127.0.0.1', port: server.port,
    username: 'hop', authType: 'password', password: 'temporary-password' })
  const verifyHost = vi.fn(async () => { throw new Error('Background must not prompt') })
  const keyboard = vi.fn(async () => { throw new Error('Background must not prompt') })
  const pool = new ConnectionPool(vault, { verifyHost, onKeyboard: keyboard, verifyHostWithoutPrompt: async () => true })
  const sample = vi.fn<typeof collectHost>(async (executor, hostId) => {
    const result = await executor.exec(hostId, "printf '===HOPLINE:uptime===\\n42 0\\n\\n#HOPLINE-END\\n'")
    expect(result.code).toBe(0)
    return parseCollect(result.stdout, Date.now())
  })
  const service = new CollectService({ pool, hosts: () => vault.listHosts(), filePath: path.join(directory, 'snapshots.json'), updated() {}, collect: sample })
  service.setWindowOpen(false)
  try {
    const first = service.runBackground(host.id), second = service.runBackground(host.id), manual = service.run(host.id)
    expect(second).toBe(first)
    const result = await first
    expect(result).toMatchObject({ status: 'success', record: { snapshot: { uptime: { status: 'complete', data: { seconds: 42 } } } } })
    expect(await manual).toEqual(result.record)
    expect(sample).toHaveBeenCalledOnce()
    expect(server.acceptedConnections).toBe(1)
    expect((await service.runBackground(host.id)).attemptId).not.toBe(result.attemptId)
    expect(server.acceptedConnections).toBe(1)
    await server.close()
    await vi.waitFor(() => expect(pool.isOpen(host.id)).toBe(false))
    const failed = await service.runBackground(host.id)
    expect(failed).toMatchObject({ status: 'connection-failed', reason: 'connection' })
    expect(failed.record.snapshot?.uptime).toEqual(result.record.snapshot?.uptime)
    expect(failed.record.error).toBe('连接被拒绝')
    expect(sample).toHaveBeenCalledTimes(2)
    expect(verifyHost).not.toHaveBeenCalled(); expect(keyboard).not.toHaveBeenCalled()
  } finally {
    service.stop(); await pool.closeAll(); await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
