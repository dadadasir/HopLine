import { once } from 'node:events'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { connectEndpoint } from '../src/main/ssh/connect'

describe('connection settings over loopback TCP', () => {
  it.each([5, 6])('abandons a silent SSH handshake at the configured %s seconds and closes its socket', async (seconds) => {
    const sockets = new Set<Socket>()
    let accepted = 0
    // Accept TCP and consume the client banner, but never send an SSH banner.
    // The SSH client's readyTimeout must end the attempt, not a server timeout.
    const server = createServer((socket) => {
      accepted += 1
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => undefined)
      socket.resume()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    const verifyHost = vi.fn(async () => true)
    const onKeyboard = vi.fn(async () => null)
    const controller = new AbortController()
    try {
      const started = performance.now()
      await expect(connectEndpoint({
        host: '127.0.0.1', port, username: 'hop',
        connectionTimeoutSec: seconds, keepaliveIntervalSec: 0,
        auth: { authType: 'password', password: 'temporary-test-password', privateKey: null, privateKeyPath: null, passphrase: null }
      }, { verifyHost, onKeyboard, signal: controller.signal })).rejects.toThrow('连接超时')
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(seconds * 1000 - 100)
      expect(elapsed).toBeLessThan(seconds * 1000 + 2000)
      expect(accepted).toBe(1)
      expect(verifyHost).not.toHaveBeenCalled()
      expect(onKeyboard).not.toHaveBeenCalled()
      // Assert remote EOF before our cleanup, so fixture teardown cannot hide leaks.
      await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1000, interval: 10 })
    } finally {
      controller.abort()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
