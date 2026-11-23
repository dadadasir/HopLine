/// <reference path="../src/renderer/src/env.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'
import {
  backupNow, closeTab, getState, notifyEditSync, patch, queueAuthentication,
  reconnectTab, respondAuthentication, toast, type AuthenticationPrompt
} from '../src/renderer/src/state'
import { attachTerminal, detachTerminal, writeTerminal } from '../src/renderer/src/terminal/registry'

const initial = getState()
const bridge = {
  platform: 'darwin',
  backup: { auto: vi.fn(), status: vi.fn() },
  ssh: { reconnect: vi.fn(), disconnect: vi.fn(), respondHostKey: vi.fn(), respondKeyboard: vi.fn() },
  pty: { close: vi.fn() },
  shell: { showItem: vi.fn() }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.stubGlobal('window', { hopline: bridge })
  bridge.backup.status.mockResolvedValue({ hasPassword: true, unlocked: true })
  patch({ ...initial, toasts: [], prompts: [], tabs: [] })
})
afterEach(() => {
  detachTerminal('ssh-1')
  detachTerminal('local-1')
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('authentication responses', () => {
  const host: AuthenticationPrompt = {
    kind: 'hostKey', requestId: 'host-1', host: 'example', port: 22,
    fingerprint: 'SHA256:test', keyType: 'ssh-ed25519', mismatch: false
  }
  const keyboard: AuthenticationPrompt = {
    kind: 'keyboard', requestId: 'kbd-1', name: '', instructions: '',
    prompts: [{ prompt: 'Password', echo: false }]
  }

  it('queues mixed prompts, routes cancellations, and ignores a double response', async () => {
    queueAuthentication(host)
    queueAuthentication(keyboard)
    await respondAuthentication(host, 'reject')
    expect(bridge.ssh.respondHostKey).toHaveBeenCalledWith('host-1', 'reject')
    expect(getState().prompts).toEqual([keyboard])
    await respondAuthentication(host, 'save')
    expect(bridge.ssh.respondHostKey).toHaveBeenCalledTimes(1)
    await respondAuthentication(keyboard, null)
    expect(bridge.ssh.respondKeyboard).toHaveBeenCalledWith('kbd-1', null)
    expect(getState().prompts).toEqual([])
  })

  it('does not discard prompts that arrive while a response is in flight', async () => {
    let complete!: () => void
    bridge.ssh.respondHostKey.mockReturnValue(new Promise<void>((resolve) => { complete = resolve }))
    queueAuthentication(host)
    const response = respondAuthentication(host, 'once')
    queueAuthentication(keyboard)
    complete()
    await response
    expect(getState().prompts).toEqual([keyboard])
    await respondAuthentication(keyboard, ['secret'])
    expect(bridge.ssh.respondKeyboard).toHaveBeenCalledWith('kbd-1', ['secret'])
  })

  it('reports IPC failures without hiding the next prompt', async () => {
    bridge.ssh.respondHostKey.mockRejectedValue(new Error('IPC failed'))
    queueAuthentication(host)
    queueAuthentication(keyboard)
    await respondAuthentication(host, 'save')
    expect(getState().prompts).toEqual([keyboard])
    expect(getState().toasts[0]).toMatchObject({ tone: 'err', text: 'IPC failed' })
  })
})

describe('back up now', () => {
  it('creates a backup and displays the returned filename', async () => {
    bridge.backup.auto.mockResolvedValue('2026-10-27.hopline-backup')
    await backupNow()
    expect(bridge.backup.auto).toHaveBeenCalledTimes(1)
    expect(getState().settingsOpen).toBe(false)
    expect(getState().toasts[0]).toMatchObject({ tone: 'ok' })
    expect(getState().toasts[0].text).toContain('2026-10-27.hopline-backup')
  })

  it('opens backup settings and explains how to enable backups when unavailable', async () => {
    bridge.backup.auto.mockResolvedValue(null)
    await backupNow()
    expect(getState().settingsOpen).toBe('backup')
    expect(getState().toasts[0]).toMatchObject({ tone: 'warning' })
    expect(getState().toasts[0].text).toContain('主密码')
    expect(getState().toasts[0].text).toContain('解锁')
  })

  it('shows an error instead of claiming success', async () => {
    bridge.backup.auto.mockRejectedValue(new Error('disk full'))
    await backupNow()
    expect(getState().toasts).toHaveLength(1)
    expect(getState().toasts[0]).toMatchObject({ tone: 'err' })
    expect(getState().toasts[0].text).toContain('disk full')
  })

  it('does not misreport a saved backup as failed when status refresh fails', async () => {
    bridge.backup.auto.mockResolvedValue('saved.hopline-backup')
    bridge.backup.status.mockRejectedValue(new Error('status unavailable'))
    await backupNow()
    expect(getState().toasts[0].text).toContain('saved.hopline-backup')
    expect(getState().toasts[1].text).toBe('status unavailable')
  })
})

describe('reconnecting terminals', () => {
  beforeEach(() => bridge.ssh.reconnect.mockResolvedValue({ id: 'ssh-1', kind: 'ssh', status: 'connected', title: 'SSH' }))

  it('uses the target terminal dimensions even if a different tab is active', async () => {
    attachTerminal('ssh-1', { cols: 137, rows: 41, dispose: vi.fn() } as unknown as Terminal, {} as SearchAddon)
    patch({ activeId: 'another-tab' })
    await reconnectTab('ssh-1')
    expect(bridge.ssh.reconnect).toHaveBeenCalledWith('ssh-1', 137, 41)
  })

  it('uses fallback dimensions only when the terminal is missing', async () => {
    await reconnectTab('ssh-1')
    expect(bridge.ssh.reconnect).toHaveBeenCalledWith('ssh-1', 100, 32)
  })
})

describe('closing tabs', () => {
  const tabs = [
    { id: 'ssh-1', kind: 'ssh' as const, title: 'SSH', status: 'connected' as const, sftpOpen: false },
    { id: 'local-1', kind: 'local' as const, title: 'Local', status: 'connected' as const, sftpOpen: false }
  ]

  it.each([['ssh-1', 'disconnect'], ['local-1', 'close']] as const)('keeps %s open for a retry when closing fails', async (id, method) => {
    patch({ tabs, activeId: id, transfers: { [id]: [] } })
    const target = method === 'disconnect' ? bridge.ssh.disconnect : bridge.pty.close
    target.mockRejectedValueOnce(new Error('未回传修改保全失败，本地副本已保留'))
    await closeTab(id)
    expect(getState().tabs.map((tab) => tab.id)).toEqual(['ssh-1', 'local-1'])
    expect(getState().activeId).toBe(id)
    expect(getState().transfers[id]).toEqual([])
    expect(getState().toasts[0]).toMatchObject({ tone: 'err', text: '未回传修改保全失败，本地副本已保留' })
    target.mockResolvedValueOnce(undefined)
    await closeTab(id)
    expect(getState().tabs.map((tab) => tab.id)).toEqual(tabs.filter((tab) => tab.id !== id).map((tab) => tab.id))
    expect(getState().transfers[id]).toBeUndefined()
  })

  it.each([
    ['ssh-1', 'disconnect', false], ['local-1', 'close', false],
    ['ssh-1', 'disconnect', true], ['local-1', 'close', true]
  ] as const)('clears pending %s output after %s succeeds (failure=%s)', async (id, method, failed) => {
    patch({ tabs, activeId: id })
    const first = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]), second = 'early output\r\n'
    writeTerminal(id, first)
    writeTerminal(id, second)
    const target = method === 'disconnect' ? bridge.ssh.disconnect : bridge.pty.close
    if (failed) target.mockRejectedValueOnce(new Error('close failed'))
    else target.mockResolvedValueOnce(undefined)
    await closeTab(id)
    const terminal = { write: vi.fn(), dispose: vi.fn() }
    // Attaching after the delayed pane resolves must not replay a closed
    // session's output; failed closes must preserve the same pending chunks.
    attachTerminal(id, terminal as unknown as Terminal, {} as SearchAddon)
    expect(terminal.write.mock.calls).toEqual(failed ? [[first], [second]] : [])
    expect(getState().tabs.some(tab => tab.id === id)).toBe(failed)
  })

  it('leaves mounted-terminal disposal to its normal unmount and keeps cleanup idempotent', async () => {
    patch({ tabs, activeId: 'ssh-1' })
    const terminal = { write: vi.fn(), dispose: vi.fn() }
    attachTerminal('ssh-1', terminal as unknown as Terminal, {} as SearchAddon)
    bridge.ssh.disconnect.mockResolvedValueOnce(undefined)
    await closeTab('ssh-1')
    expect(terminal.dispose).not.toHaveBeenCalled()
    detachTerminal('ssh-1')
    detachTerminal('ssh-1')
    expect(terminal.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('remote edit notifications', () => {
  const event = { sessionId: 'ssh-1', remotePath: '/etc/config.conf' }

  it('prioritizes conflicts and keeps their warning longer than ordinary toasts', () => {
    toast('ordinary')
    notifyEditSync({ ...event, conflict: true, error: 'generic error' })
    expect(getState().toasts[1]).toMatchObject({ tone: 'warning' })
    expect(getState().toasts[1].text).toContain('config.conf')
    expect(getState().toasts[1].text).toContain('没有写回远端')
    vi.advanceTimersByTime(2600)
    expect(getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(12400)
    expect(getState().toasts).toHaveLength(0)
  })

  it.each([true, false])('preserves recovery actions with conflict=%s', async (conflict) => {
    const recoveredPath = '/recovery/local config.conf'
    notifyEditSync({ ...event, conflict, error: 'Disconnected', recoveredPath })
    vi.advanceTimersByTime(60_000)
    const notice = getState().toasts[0]
    expect(notice.tone).toBe('warning')
    expect(notice.text).toContain(recoveredPath)
    expect(notice.action?.label).toBe('在访达中显示')
    await notice.action?.run()
    expect(bridge.shell.showItem).toHaveBeenCalledWith(recoveredPath)
  })

  it('preserves ordinary sync success and failure messages', () => {
    notifyEditSync(event)
    notifyEditSync({ ...event, error: 'Permission denied' })
    expect(getState().toasts[0]).toMatchObject({ tone: 'ok', text: '远程文件已更新' })
    expect(getState().toasts[1]).toMatchObject({ tone: 'err', text: 'Permission denied' })
  })

  it('does not claim a recovered file was uploaded when no error text was provided', () => {
    notifyEditSync({ ...event, recoveredPath: '/recovery/config.conf' })
    expect(getState().toasts[0].text).toContain('没有写回远端')
    expect(getState().toasts[0].text).not.toContain('远程文件已更新')
  })
})
