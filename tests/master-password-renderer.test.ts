/// <reference path="../src/renderer/src/env.d.ts" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LockedError, MASTER_PASSWORD_REQUIRED } from '../src/shared/types'
import type { HostPublic, SessionInfo } from '../src/shared/types'
import { connectHost, reconnectTab, unlockConnections } from '../src/renderer/src/state/tabs'
import { getState, patch } from '../src/renderer/src/state/store'
import { isLockedError } from '../src/renderer/src/logic/locked-error'

const host = { id: 'host', name: 'Host' } as HostPublic
const session = { id: 'session', kind: 'ssh', hostId: host.id, status: 'connected', title: host.name } as SessionInfo
const pool = { acquire: vi.fn() }
const bridge = {
  backup: { unlock: vi.fn() },
  ssh: { connect: vi.fn(), reconnect: vi.fn() }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.stubGlobal('window', { hopline: bridge })
  bridge.ssh.connect.mockImplementation(async () => { await pool.acquire(host.id); return session })
  bridge.ssh.reconnect.mockImplementation(async () => { await pool.acquire(host.id); return session })
  bridge.backup.unlock.mockResolvedValue({ hasPassword: true, unlocked: true })
  patch({ tabs: [], connecting: null, unlockPending: [], toasts: [], backup: null })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('recognizes the LockedError message after Electron serialization', () => {
  expect(isLockedError(new LockedError())).toBe(true)
  expect(isLockedError(new Error(`Error invoking remote method 'ssh:connect': LockedError: ${MASTER_PASSWORD_REQUIRED}`))).toBe(true)
  expect(isLockedError(new Error('Permission denied'))).toBe(false)
})

it('queues a locked pool connection and retries only after successful unlock', async () => {
  pool.acquire.mockRejectedValueOnce(new LockedError()).mockResolvedValue({})
  await connectHost(host)
  expect(getState().connecting).toBeNull()
  expect(getState().unlockPending?.map((item) => item.id)).toEqual([host.id])
  expect(getState().tabs).toEqual([])
  expect(getState().toasts).toEqual([])
  bridge.backup.unlock.mockRejectedValueOnce(new Error('主密码不正确'))
  await expect(unlockConnections('wrong-password')).rejects.toThrow('主密码不正确')
  expect(pool.acquire).toHaveBeenCalledTimes(1)
  expect(getState().unlockPending).toHaveLength(1)
  await unlockConnections('master-password')
  expect(bridge.backup.unlock).toHaveBeenLastCalledWith('master-password', false)
  expect(pool.acquire).toHaveBeenCalledTimes(2)
  expect(getState().unlockPending).toEqual([])
  expect(getState().tabs[0]).toMatchObject(session)
  expect(getState().backup?.unlocked).toBe(true)
})

it('queues reconnects, deduplicates attempts and retries all pending hosts', async () => {
  pool.acquire.mockRejectedValue(new LockedError())
  await connectHost(host)
  await connectHost(host)
  await reconnectTab('old-session')
  expect(getState().unlockPending).toHaveLength(2)
  pool.acquire.mockResolvedValue({})
  await unlockConnections('master-password')
  expect(bridge.ssh.connect).toHaveBeenCalledTimes(3)
  expect(bridge.ssh.reconnect).toHaveBeenLastCalledWith('old-session', 100, 32)
  expect(getState().unlockPending).toEqual([])
})

it('cancelled attempts do not retry, and ordinary errors still produce a toast', async () => {
  pool.acquire.mockRejectedValueOnce(new LockedError()).mockRejectedValue(new Error('SSH failed'))
  await connectHost(host)
  patch({ unlockPending: [] })
  await unlockConnections('master-password')
  expect(pool.acquire).toHaveBeenCalledTimes(1)
  await connectHost(host)
  expect(getState().unlockPending).toEqual([])
  expect(getState().toasts[0]).toMatchObject({ tone: 'err', text: 'SSH failed' })
})
