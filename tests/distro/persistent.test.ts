import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { distroSkipReason, startDistro } from './harness'
import { execSsh } from './ssh'
import { emptyStore, MemorySecretCodec, Vault } from '../../src/core/vault'
import { KnownHostFile } from '../../src/main/known-hosts-file'
import { SessionHub } from '../../src/main/sessions'
import { installOscPolicy } from '../../src/renderer/src/terminal/osc'

vi.mock('../../src/main/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

// All installs and process kills below are confined to Docker targets created here.
describe.skipIf(Boolean(distroSkipReason()))('M2-F persistent sessions in Docker', () => {
  async function using(name: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    const f = await fixture(name)
    try { await run(f) } finally {
      f.dispose(); f.term.dispose(); await f.hub.closeAll(); await f.hub.pool.closeAll()
      await f.target.stop(); fs.rmSync(f.directory, { recursive: true, force: true })
    }
  }
  async function fixture(name: string) {
    const target = await startDistro(name), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-persistent-distro-'))
    const vault = new Vault(emptyStore(), new MemorySecretCodec())
    const host = vault.saveHost({ name, groupId: null, host: target.host, port: target.port, username: 'root', authType: 'privateKey', privateKeyPath: target.keyPath, persistent: true })
    const known = new KnownHostFile(path.join(directory, 'known.json')), term = new Terminal({ allowProposedApi: true, cols: 100, rows: 32 })
    const onNotify = vi.fn(), dispose = installOscPolicy(term, { openExternal: vi.fn(), onNotify })
    const hub = new SessionHub(vault, known, (channel, payload: any) => {
      if (channel === 'hostkey:prompt') hub.respondHostKey(payload.requestId, 'once')
      if (channel === 'ssh:data') term.write(new Uint8Array(payload.data))
    }, directory)
    const command = (script: string, timeout = 30000) => execSsh(target, 'root', script, '', undefined, timeout)
    const screen = () => Array.from({ length: term.buffer.active.length }, (_, line) => term.buffer.active.getLine(line)?.translateToString()).join('\n')
    return { target, directory, host, hub, term, onNotify, dispose, command, screen }
  }
  it('keeps the same tmux, scrollback and long job after killing the sshd child; passes notifications and preserves unrelated options', async () => {
    await using('ubuntu-24', async (f) => {
      expect((await f.command('apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux', 240000)).code).toBe(0)
      expect((await f.command('tmux new-session -d -s unrelated')).code).toBe(0)
      const globalBefore = await f.command('tmux show-options -g; tmux show-options -gw; test ! -e ~/.tmux.conf || sha256sum ~/.tmux.conf')
      const opened = await f.hub.connect(f.host.id, 100, 32), name = opened.tmuxName!
      expect(opened.tmuxMissing).toBe(false)
      await vi.waitFor(async () => expect(await f.hub.listPersistent(f.host.id)).toEqual([expect.objectContaining({ name, attached: 1 })]))
      f.hub.write(opened.id, 'sleep 300 &\necho marker-1\n')
      await vi.waitFor(() => expect(f.screen()).toContain('marker-1'))
      const sleep = (await f.command('pgrep -x sleep')).stdout.trim()
      expect(sleep).toMatch(/^\d+$/)
      const client = (await f.command(`tmux list-clients -t '${name}' -F '#{client_pid}'`)).stdout.trim()
      expect(client).toMatch(/^\d+$/)
      const sshd = (await f.command(`ps -o ppid= -p ${client}`)).stdout.trim()
      expect(sshd).toMatch(/^\d+$/); expect(Number(sshd)).toBeGreaterThan(1)
      expect((await f.command(`ps -o comm= -p ${sshd}`)).stdout.trim()).toMatch(/^sshd/)
      expect((await f.command(`kill -KILL ${sshd}`)).code).toBe(0)
      await vi.waitFor(() => expect(f.hub.list()[0].status).toBe('closed'))
      f.term.reset()
      await vi.waitFor(() => expect(f.hub.list()[0].status).toBe('connected'), { timeout: 15000 })
      await vi.waitFor(() => expect(f.screen()).toContain('marker-1'))
      expect((await f.command('pgrep -x sleep')).stdout.trim()).toBe(sleep)
      expect(await f.hub.listPersistent(f.host.id)).toEqual([expect.objectContaining({ name, attached: 1 })])
      // tmux passthrough requires its DCS envelope; allow-passthrough does not forward bare OSC 9.
      f.hub.write(opened.id, "printf '\\033Ptmux;\\033\\033]9;done\\007\\033\\\\'\n")
      await vi.waitFor(() => expect(f.onNotify).toHaveBeenCalledWith('', { title: 'HopLine', body: 'done' }))
      expect(await f.command('tmux show-options -g; tmux show-options -gw; test ! -e ~/.tmux.conf || sha256sum ~/.tmux.conf')).toEqual(globalBefore)
      await f.hub.close(opened.id)
      expect((await f.command(`tmux has-session -t '${name}'`)).code).toBe(0)
      const reattached = await f.hub.connect(f.host.id, 100, 32, { tmuxName: name })
      expect(reattached.tmuxName).toBe(name)
      await f.hub.killPersistent(f.host.id, name)
      expect((await f.command(`tmux has-session -t '${name}'`)).code).not.toBe(0)
    })
  }, 300000)
  it('Alpine without tmux falls back to a usable ordinary shell and exposes the notice flag', async () => {
    await using('alpine-3', async (f) => {
      expect((await f.command('command -v tmux')).code).not.toBe(0)
      const session = await f.hub.connect(f.host.id, 100, 32)
      expect(session).toMatchObject({ status: 'connected', tmuxMissing: true })
      f.hub.write(session.id, 'echo plain-shell-marker\n')
      await vi.waitFor(() => expect(f.screen()).toContain('plain-shell-marker'))
      expect((await f.command('command -v tmux')).code).not.toBe(0)
    })
  })
})
