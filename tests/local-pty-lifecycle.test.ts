import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { KnownHostFile } from '../src/main/known-hosts-file'
import { SessionHub } from '../src/main/sessions'

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), resolveUnpacked: vi.fn() }))
vi.mock('../src/core/win-platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/win-platform')>(),
  resolveAsarUnpackedModule: mocked.resolveUnpacked
}))
vi.mock('node-pty', () => ({ spawn: mocked.spawn }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

function fakePty() {
  let onData = (_data: string) => {}, onExit = (_event: { exitCode: number }) => {}
  return {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData(listener: typeof onData) { onData = listener },
    onExit(listener: typeof onExit) { onExit = listener },
    data(data: string) { onData(data) },
    exit(exitCode: number) { onExit({ exitCode }) }
  }
}

let directory: string, hub: SessionHub
const emit = vi.fn()
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-local-pty-'))
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  hub = new SessionHub(vault, new KnownHostFile(path.join(directory, 'known.json')), emit, directory)
  emit.mockClear(); mocked.spawn.mockReset(); mocked.resolveUnpacked.mockReset().mockReturnValue('node-pty')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await hub.closeAll(); await hub.pool.closeAll()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('ignores local PTY output and exit after explicit close begins or finishes without affecting another session', async () => {
  const closedPty = fakePty(), activePty = fakePty()
  mocked.spawn.mockReturnValueOnce(closedPty).mockReturnValueOnce(activePty)
  const closed = await hub.openLocal(80, 24), active = await hub.openLocal(80, 24)
  closedPty.data('before close')
  expect(emit).toHaveBeenCalledExactlyOnceWith('pty:data', { sessionId: closed.id, data: 'before close' })
  emit.mockClear()
  closedPty.kill.mockImplementation(() => { closedPty.data('during kill'); closedPty.exit(129) })
  const closing = hub.close(closed.id)
  closedPty.data('close is pending'); closedPty.exit(129)
  await closing
  closedPty.data('after close'); closedPty.exit(129)
  expect(emit).not.toHaveBeenCalled()
  expect(closedPty.kill).toHaveBeenCalledTimes(1)
  expect(hub.list().map(session => session.id)).toEqual([active.id])
  activePty.data('still live')
  expect(emit).toHaveBeenCalledExactlyOnceWith('pty:data', { sessionId: active.id, data: 'still live' })
})

it('keeps a naturally exited local session visible and reports its final output and exit status', async () => {
  const terminal = fakePty()
  mocked.spawn.mockReturnValue(terminal)
  const session = await hub.openLocal(80, 24)
  terminal.data('last output\r\n'); terminal.exit(7)
  expect(emit.mock.calls).toEqual([
    ['pty:data', { sessionId: session.id, data: 'last output\r\n' }],
    ['pty:exit', { sessionId: session.id, exitCode: 7 }],
    ['ssh:status', expect.objectContaining({ id: session.id, kind: 'local', status: 'closed', message: '进程已退出 (7)' })]
  ])
  expect(hub.list()).toEqual([expect.objectContaining({ id: session.id, status: 'closed', message: '进程已退出 (7)' })])
  expect(terminal.kill).not.toHaveBeenCalled()
})

it('does not let a retired PTY overwrite the error when a failed close restores the same session for retry', async () => {
  const terminal = fakePty()
  mocked.spawn.mockReturnValue(terminal)
  const session = await hub.openLocal(80, 24)
  const watch = path.join(directory, 'watch', session.id)
  fs.mkdirSync(watch, { recursive: true })
  const localPath = path.join(watch, 'unsynced.txt')
  fs.writeFileSync(localPath, 'unsynced edit')
  hub['sessions'].get(session.id)!.watchers.set('/unsynced.txt', {
    chain: Promise.resolve(), controller: new AbortController(), stopped: false,
    localPath, manifestPath: path.join(watch, '.hopline-edit.json'), dirty: true, revision: 1
  })
  const obstruction = path.join(directory, 'recovered')
  fs.writeFileSync(obstruction, 'blocks recovery')
  await expect(hub.close(session.id)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(terminal.kill).toHaveBeenCalledTimes(1)
  const restored = hub.list()[0]
  expect(restored).toMatchObject({ id: session.id, status: 'error', message: '未回传修改保全失败，本地副本已保留' })
  emit.mockClear()
  terminal.data('late output'); terminal.exit(129)
  expect(emit).not.toHaveBeenCalled()
  expect(hub.list()).toEqual([restored])
  fs.unlinkSync(obstruction)
  await hub.close(session.id)
  expect(hub.list()).toEqual([])
  expect(terminal.kill).toHaveBeenCalledTimes(1)
  expect(fs.readFileSync(path.join(obstruction, fs.readdirSync(obstruction)[0]!), 'utf8')).toBe('unsynced edit')
})

it.skipIf(process.platform === 'win32')('keeps the POSIX logical node-pty path even when a physical unpacked package exists', async () => {
  mocked.resolveUnpacked.mockReturnValue('/fixture/Hopline.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty')
  mocked.spawn.mockReturnValue(fakePty())
  const session = await hub.openLocal(80, 24)
  expect(session.kind).toBe('local')
  expect(mocked.spawn).toHaveBeenCalledOnce()
  expect(mocked.resolveUnpacked).not.toHaveBeenCalled()
})
