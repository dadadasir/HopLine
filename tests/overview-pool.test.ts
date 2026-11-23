import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { afterEach, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { ConnectionPool } from '../src/main/ssh/pool'
import * as connection from '../src/main/ssh/connect'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
it('isOpen is read-only and excludes pending, retired, disconnected, idle-expired and closed connections', async () => {
  vi.useFakeTimers()
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  const id = vault.saveHost({ name: 'test', groupId: null, host: '127.0.0.1', port: 22, username: 'test', authType: 'password' }).id
  let ready!: (value: connection.OpenedConnection) => void
  const open = vi.spyOn(connection, 'connectEndpoint').mockImplementation(() => new Promise((resolve) => { ready = resolve }))
  const pool = new ConnectionPool(vault, { idleMs: 100, verifyHost: async () => true, onKeyboard: async () => null })
  try {
    expect(pool.isOpen(id)).toBe(false); expect(open).not.toHaveBeenCalled()
    const pending = pool.acquire(id); await Promise.resolve()
    expect(pool.isOpen(id)).toBe(false); expect(open).toHaveBeenCalledTimes(1)
    const client = Object.assign(new EventEmitter(), { end: vi.fn() })
    ready({ client: client as unknown as Client, jumps: [] })
    const lease = await pending
    expect(pool.isOpen(id)).toBe(true)
    pool.invalidate(id); expect(pool.isOpen(id)).toBe(false)
    lease.release()
    open.mockResolvedValue({ client: client as unknown as Client, jumps: [] })
    const second = await pool.acquire(id)
    expect(pool.isOpen(id)).toBe(true)
    client.emit('close'); expect(pool.isOpen(id)).toBe(false)
    second.release()
    const third = await pool.acquire(id); third.release()
    expect(pool.isOpen(id)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(pool.isOpen(id)).toBe(false)
    const fourth = await pool.acquire(id)
    await pool.closeAll(); expect(pool.isOpen(id)).toBe(false); fourth.release()
  } finally { await pool.closeAll() }
})
