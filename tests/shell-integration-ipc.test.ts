import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IpcDeps } from '../src/main/ipc'
import type { RunbookService } from '../src/main/runbook-service'
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }))
import { registerIpc } from '../src/main/ipc'
import { ShellIntegrationStore } from '../src/main/shell-integration-store'

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-shell-ipc-')); handlers.clear() })
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })
it('wires verified runbook status to persistence and clears only removed hosts behind the caller guard', async () => {
  const store = new ShellIntegrationStore(directory), hosts = new Set(['a', 'b', 'c'])
  store.set('orphan', true)
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const runbook = { deleteHost: vi.fn(), prune: vi.fn() } as unknown as RunbookService
  registerIpc({ userData: directory, runbook, shots: false, getWindow: () => win, save: vi.fn(),
    vault: { getHost: (id: string) => hosts.has(id), deleteHost: (id: string) => hosts.delete(id) },
    sessions: { closeHost: vi.fn(async () => {}), pool: { invalidate: vi.fn(), invalidateAll: vi.fn() } },
    backup: { scheduleAuto: vi.fn(), importFrom: async () => { hosts.delete('b') }, webdav: async () => { hosts.delete('c') } }
  } as unknown as IpcDeps)
  expect(store.has('orphan')).toBe(false)
  for (const id of hosts) runbook.shellIntegrationChanged!(id, true)
  expect(() => handlers.get('hosts:delete')!({ sender: {} }, 'a')).toThrow('拒绝')
  expect(store.has('a')).toBe(true)
  const event = { sender: win.webContents }
  handlers.get('hosts:delete')!(event, 'a'); expect(store.has('a')).toBe(false); expect(store.has('b')).toBe(true)
  await handlers.get('backup:import')!(event, '/tmp/fixture', null, 'replace')
  expect(store.has('b')).toBe(false); expect(store.has('c')).toBe(true)
  await handlers.get('backup:webdav')!(event, 'pull', null, 'replace', 'restore-request')
  expect(store.has('c')).toBe(false)
})
it('clears installation status when changing the SSH account or endpoint, but keeps it for renames', () => {
  const store = new ShellIntegrationStore(directory), host = { id: 'host', name: 'old', host: '127.0.0.1', port: 22, username: 'root' }
  store.set(host.id, true)
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  registerIpc({ userData: directory, shots: false, getWindow: () => win, save: vi.fn(),
    vault: { getHost: () => host, saveHostWithGroup: (input: object) => Object.assign(host, input) },
    sessions: { closeHost: vi.fn(async () => {}), pool: { invalidate: vi.fn() } }, backup: { scheduleAuto: vi.fn() }
  } as unknown as IpcDeps)
  const save = (input: object) => handlers.get('hosts:save')!({ sender: win.webContents }, { id: host.id, ...input })
  save({ name: 'renamed' }); expect(store.has(host.id)).toBe(true)
  save({ username: 'admin' }); expect(store.has(host.id)).toBe(false)
  store.set(host.id, true); save({ port: 2222 }); expect(store.has(host.id)).toBe(false)
})
