import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { SessionHub } from '../src/main/sessions'
import { startMiniSshd } from './support/mini-sshd.mjs'
vi.mock('../src/main/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
let dir: string, hub: SessionHub, hostId: string, server: Awaited<ReturnType<typeof startMiniSshd>>
const emit = vi.fn()
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-persistent-'))
  server = await startMiniSshd({ root: path.join(dir, 'server'), password: 'test' })
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  hostId = vault.saveHost({ name: 'test', groupId: null, host: '127.0.0.1', port: server.port, username: 'hop', authType: 'password', password: 'test', persistent: true }).id
  const known = new KnownHostFile(path.join(dir, 'known.json')); vi.spyOn(known, 'judge').mockReturnValue('trusted')
  emit.mockReset(); hub = new SessionHub(vault, known, emit, dir)
})
afterEach(async () => {
  await hub?.closeAll(); await hub?.pool.closeAll(); await server?.close()
  vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true })
})
const result = (stdout = '', code = 0) => ({ stdout, code, stderr: '', signal: null, timedOut: false, truncated: false })
const output = () => emit.mock.calls.filter(([channel]) => channel === 'ssh:data').map(([, payload]) => Buffer.from(payload.data).toString()).join('')

it('uses real loopback exec probe without installation, falls back to a usable shell', async () => {
  const exec = vi.spyOn(hub.pool, 'exec')
  const session = await hub.connect(hostId, 80, 24)
  expect(exec).toHaveBeenCalledWith(hostId, 'command -v tmux', expect.any(Object))
  const probe = await exec.mock.results[0].value
  expect(session.tmuxMissing).toBe(probe.code !== 0 || !probe.stdout.trim())
  hub.write(session.id, 'safe echo only\n')
  await vi.waitFor(() => expect(output()).toContain('safe echo only'))
  expect(exec.mock.calls.every(([, command]) => command === 'command -v tmux')).toBe(true)
})
it('emits a scoped tmux command; reconnects automatically to the same name after SSH transport loss; close never kills', async () => {
  const exec = vi.spyOn(hub.pool, 'exec').mockResolvedValue(result('/usr/bin/tmux\n'))
  const session = await hub.connect(hostId, 80, 24)
  expect(session.tmuxName).toMatch(/^hopline-[0-9a-f]{6}$/)
  await vi.waitFor(() => expect(output()).toContain(`exec tmux new-session -A -s '${session.tmuxName}'`))
  expect(output()).toContain('\\; set-option -t')
  expect(output()).toContain('allow-passthrough on')
  expect(output()).not.toContain(' -g ')
  emit.mockClear(); server.disconnectAll()
  await vi.waitFor(() => expect(hub.list()[0].status).toBe('closed'))
  await vi.waitFor(() => expect(output()).toContain(`exec tmux new-session -A -s '${session.tmuxName}'`), { timeout: 10000 })
  expect(hub.list()[0]).toMatchObject({ tmuxName: session.tmuxName, status: 'connected' })
  await hub.close(session.id)
  expect(hub.list()).toEqual([])
  expect(exec.mock.calls.some(([, command]) => command.includes('kill-session'))).toBe(false)
})
it('supports one-shot override, restored names, missing-tmux fallback and strict command validation', async () => {
  const exec = vi.spyOn(hub.pool, 'exec').mockResolvedValue(result('', 1))
  const ordinary = await hub.connect(hostId, 80, 24, { persistent: false })
  expect(ordinary.tmuxName).toBeUndefined(); expect(exec).not.toHaveBeenCalled()
  const session = await hub.connect(hostId, 80, 24, { tmuxName: 'hopline-abc123' })
  expect(session).toMatchObject({ tmuxName: 'hopline-abc123', tmuxMissing: true, status: 'connected' })
  await vi.waitFor(() => expect(output()).toContain('hop-shell-ready'))
  expect(output()).not.toContain('exec tmux')
  for (const name of ['other', 'hopline-abc123; id', 'hopline-$(id)']) {
    await expect(hub.connect(hostId, 80, 24, { tmuxName: name })).rejects.toThrow()
    await expect(hub.killPersistent(hostId, name)).rejects.toThrow()
  }
  expect(hub.list()).toHaveLength(2)
})
it('lists only validated HopLine sessions and kills only an explicit target', async () => {
  const exec = vi.spyOn(hub.pool, 'exec').mockResolvedValue(result('user 1 1\nhopline-abc123 100 1\nhopline-def456 200 0\nhopline-abc123 NaN 1\n'))
  expect(await hub.listPersistent(hostId)).toEqual([{ name: 'hopline-abc123', activity: 100, attached: 1 }, { name: 'hopline-def456', activity: 200, attached: 0 }])
  expect(exec.mock.calls[0][1]).toBe("tmux ls -F '#{session_name} #{session_activity} #{session_attached}'")
  await hub.killPersistent(hostId, 'hopline-abc123')
  expect(exec.mock.calls[1][1]).toBe("tmux kill-session -t '=hopline-abc123'")
  exec.mockResolvedValue(result('', 1)); await expect(hub.listPersistent(hostId)).rejects.toThrow()
})
it('cancels a scheduled automatic retry when the tab closes', async () => {
  const exec = vi.spyOn(hub.pool, 'exec').mockResolvedValue(result('/usr/bin/tmux\n'))
  const session = await hub.connect(hostId, 80, 24)
  server.disconnectAll()
  await vi.waitFor(() => expect(hub.list()[0].status).toBe('closed'))
  await hub.close(session.id)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  expect(exec).toHaveBeenCalledOnce(); expect(hub.list()).toEqual([])
})
