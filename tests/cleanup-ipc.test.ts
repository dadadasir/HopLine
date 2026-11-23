import { RunbookService } from '../src/main/runbook-service'
import { OpLog } from '../src/main/oplog'
import { beforeEach, expect, it, vi } from 'vitest'
import { cleanupDuCommand } from '../src/core/runbook/cleanup'
import type { HoplineApi } from '../src/shared/api'
import type { IpcDeps } from '../src/main/ipc'
const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke }, webUtils: {}, ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi
beforeEach(() => vi.clearAllMocks())
it('bridges owned permission probes while preserving the legacy call and validating request ids', async () => {
  await bridge.cleanup.sudo('host')
  await bridge.cleanup.sudo('host', 'permission-request')
  expect(mocks.invoke.mock.calls).toEqual([['cleanup:sudo', 'host'], ['cleanup:sudo', 'host', 'permission-request']])
  const win = { isDestroyed: () => false, webContents: {} }, runbook = { sudo: vi.fn() }
  registerIpc({ getWindow: () => win, runbook, shots: false } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'cleanup:sudo')![1], event = { sender: win.webContents }
  expect(() => handler({ sender: {} }, 'host', 'permission-request')).toThrow('拒绝')
  for (const request of [null, 1, {}, [], '']) expect(() => handler(event, 'host', request)).toThrow('参数')
  expect(() => handler(event, '', 'permission-request')).toThrow('参数')
  expect(runbook.sudo).not.toHaveBeenCalled()
  handler(event, 'host'); handler(event, 'host', 'permission-request')
  expect(runbook.sudo.mock.calls).toEqual([['host'], ['host', 'permission-request']])
})
it('bridges du, rejects untrusted callers/hosts/mounts, caps output and preserves timeout results', async () => {
  await bridge.cleanup.du('host', '/data')
  expect(mocks.invoke).toHaveBeenCalledWith('cleanup:du', 'host', '/data')
  const win = { isDestroyed: () => false, webContents: {} }, exec = vi.fn().mockResolvedValue({ code: null, stdout: '8\t/data/a\n16\t/data/b\nunfinished', timedOut: true, truncated: true })
  const runbook = new RunbookService({ exec }, new OpLog('/unused-by-read-only-test'), () => true, () => {})
  registerIpc({ getWindow: () => win, runbook, vault: { getHost: (id: string) => id === 'host' }, sessions: { pool: { exec } }, shots: false } as unknown as IpcDeps)
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'cleanup:du')![1], event = { sender: win.webContents }
  await expect(handler({ sender: {} }, 'host', '/')).rejects.toThrow('拒绝')
  await expect(handler(event, 'missing', '/')).rejects.toThrow('主机不存在')
  await expect(handler(event, 'host', '-rf')).rejects.toThrow('cleanup.invalidMount')
  expect(exec).not.toHaveBeenCalled()
  expect(await handler(event, 'host', '/data')).toEqual({ output: '16\t/data/b\n8\t/data/a', timedOut: true, truncated: true, incomplete: true })
  expect(exec).toHaveBeenCalledWith('host', cleanupDuCommand('/data'), { timeoutMs: 30_000, maxOutputBytes: 262144, signal: expect.any(AbortSignal) })
})
