import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { distroSkipReason, startDistro } from './harness'
import { execSsh } from './ssh'
import { emptyStore, MemorySecretCodec, Vault } from '../../src/core/vault'
import { shellEscape } from '../../src/core/shell'
import { installShellIntegration, uninstallShellIntegration } from '../../src/core/runbook/shell-integration'
import { KnownHostFile } from '../../src/main/known-hosts-file'
import { SessionHub } from '../../src/main/sessions'
import { ShellIntegrationStore } from '../../src/main/shell-integration-store'
import { ShellMarks } from '../../src/renderer/src/terminal/marks'

vi.mock('../../src/main/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

// Only the disposable Ubuntu target created by this harness is ever contacted.
describe.skipIf(Boolean(distroSkipReason()))('M2-G Ubuntu shell integration', () => {
  it.each([false, true])('opt-in prompt/output/exit markers, plain SSH isolation and byte-exact uninstall (tmux=%s)', async (persistent) => {
    const target = await startDistro('ubuntu-24')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-shell-distro-'))
    const vault = new Vault(emptyStore(), new MemorySecretCodec())
    const host = vault.saveHost({ name: 'integration', groupId: null, host: target.host, port: target.port, username: 'root', authType: 'privateKey', privateKeyPath: target.keyPath })
    const term = new Terminal({ allowProposedApi: true, cols: 100, rows: 32 })
    let hostname = '', output = '', streamOutput = ''
    const marks = new ShellMarks(term, () => hostname), store = new ShellIntegrationStore(directory)
    const hub = new SessionHub(vault, new KnownHostFile(path.join(directory, 'known.json')), (channel, payload: any) => {
      if (channel === 'hostkey:prompt') hub.respondHostKey(payload.requestId, 'once')
      if (channel === 'ssh:data') {
        const data = Buffer.from(payload.data); output += data.toString(); streamOutput += data.toString(); term.write(new Uint8Array(data))
      }
    }, directory)
    const command = (script: string, timeout = 30000) => execSsh(target, 'root', script, '', undefined, timeout)
    const run = (script: string) => command(`sh -c ${shellEscape(script)}`)
    try {
      const before = await command('cat ~/.bashrc'); expect(before.code).toBe(0)
      if (persistent) expect((await command('apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux', 240000)).code).toBe(0)
      expect(await run(installShellIntegration.steps[0].apply)).toMatchObject({ code: 0 })
      expect(await run(installShellIntegration.steps[0].verify)).toMatchObject({ code: 0 })
      // A real ordinary SSH PTY receives no opt-in variable, even with the script installed.
      const plain = await hub.connect(host.id, 100, 32)
      hub.write(plain.id, 'printf "plain-ready\\n"\n')
      await vi.waitFor(() => expect(output, JSON.stringify(output)).toMatch(/[\r\n]plain-ready\r?\n/))
      expect(output).not.toContain('\x1b]133;')
      await hub.close(plain.id); output = ''; store.set(host.id, true)
      const integrated = await hub.connect(host.id, 100, 32, { persistent })
      hostname = integrated.shellHostname ?? ''
      if (persistent) {
        // tmux draws on the alternate screen, where command marks are meaningless; only the cwd is followed.
        await vi.waitFor(() => expect(streamOutput).toContain('\x1b]133;A'), { timeout: 15000 })
        hub.write(integrated.id, 'cd /tmp\n')
        await vi.waitFor(() => expect(marks.cwd).toBe('/tmp'))
        hub.write(integrated.id, 'false\n')
        await vi.waitFor(() => expect(streamOutput).toContain('\x1b]133;D;1'))
        expect(streamOutput).toContain('\x1b]133;C')
        expect(marks.active).toBe(false)
        await hub.killPersistent(host.id, integrated.tmuxName!)
      } else {
        await vi.waitFor(() => expect(marks.active).toBe(true), { timeout: 15000 })
        hub.write(integrated.id, 'cd /tmp\n')
        await vi.waitFor(() => expect(marks.cwd).toBe('/tmp'))
        hub.write(integrated.id, 'false\n')
        await vi.waitFor(() => expect(marks.commands.some((item) => item.code === 1)).toBe(true))
        hub.write(integrated.id, 'printf "copied-output\\n"\n')
        await vi.waitFor(() => expect(marks.output()).toBe('copied-output'))
        await hub.close(integrated.id)
      }
      expect(await run(uninstallShellIntegration.steps[0].apply)).toMatchObject({ code: 0 })
      expect(await command('cat ~/.bashrc')).toEqual(before)
      expect(await command('test ! -e ~/.bashrc.hopline-backup')).toMatchObject({ code: 0 })
    } finally {
      marks.dispose(); term.dispose(); await hub.closeAll(); await hub.pool.closeAll()
      await target.stop(); fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 300000)
})
