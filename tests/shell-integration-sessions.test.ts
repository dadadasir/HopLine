import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { SessionHub } from '../src/main/sessions'
import { ShellIntegrationStore } from '../src/main/shell-integration-store'
import { startMiniSshd } from './support/mini-sshd.mjs'

vi.mock('../src/main/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
let directory: string, hub: SessionHub, hostId: string, server: Awaited<ReturnType<typeof startMiniSshd>>, store: ShellIntegrationStore
const emit = vi.fn()
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-integration-session-'))
  server = await startMiniSshd({ root: path.join(directory, 'server'), password: 'test' })
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  hostId = vault.saveHost({ name: 'test', groupId: null, host: '127.0.0.1', port: server.port, username: 'hop', authType: 'password', password: 'test', startupCommand: 'echo startup-once' }).id
  const known = new KnownHostFile(path.join(directory, 'known.json')); vi.spyOn(known, 'judge').mockReturnValue('trusted')
  emit.mockReset(); hub = new SessionHub(vault, known, emit, directory); store = new ShellIntegrationStore(directory)
})
afterEach(async () => {
  await hub?.closeAll(); await hub?.pool.closeAll(); await server?.close()
  vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true })
})
const output = () => emit.mock.calls.filter(([channel]) => channel === 'ssh:data').map(([, payload]) => Buffer.from(payload.data).toString()).join('')
const result = (stdout = '', code = 0) => ({ stdout, code, stderr: '', signal: null, timedOut: false, truncated: false })
it('loopback: only marked hosts export integration, retain startup once, and reconnect rechecks the store', async () => {
  const plain = await hub.connect(hostId, 80, 24)
  await vi.waitFor(() => expect(output()).toContain('echo startup-once'))
  expect(output()).not.toContain('HOPLINE_SHELL_INTEGRATION'); expect(plain.shellHostname).toBeUndefined()
  await hub.close(plain.id); emit.mockClear(); store.set(hostId, true)
  const integrated = await hub.connect(hostId, 80, 24)
  await vi.waitFor(() => expect(output()).toContain('export HOPLINE_SHELL_INTEGRATION=1; echo startup-once\nexec "$SHELL" -l'))
  expect(integrated.shellHostname).toBeTruthy()
  expect(output().match(/echo startup-once/g)).toHaveLength(1)
  store.set(hostId, false); emit.mockClear()
  await hub.reconnect(integrated.id, 80, 24)
  await vi.waitFor(() => expect(output()).toContain('echo startup-once'))
  expect(output()).not.toContain('HOPLINE_SHELL_INTEGRATION')
})
it('loopback: tmux gets a per-session environment; missing tmux falls back to the integrated login shell', async () => {
  store.set(hostId, true)
  const probe = vi.spyOn(hub.pool, 'exec').mockResolvedValue(result('/usr/bin/tmux\n'))
  const persistent = await hub.connect(hostId, 80, 24, { persistent: true })
  await vi.waitFor(() => expect(output()).toContain(`exec tmux new-session -A -s '${persistent.tmuxName}' -e HOPLINE_SHELL_INTEGRATION=1`))
  expect(output()).toContain('echo startup-once'); expect(output()).not.toContain('export HOPLINE_SHELL_INTEGRATION')
  await hub.close(persistent.id); emit.mockClear(); probe.mockResolvedValue(result('', 1))
  expect(await hub.connect(hostId, 80, 24, { persistent: true })).toMatchObject({ tmuxMissing: true })
  await vi.waitFor(() => expect(output()).toContain('export HOPLINE_SHELL_INTEGRATION=1;'))
})
