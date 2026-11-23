import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ directory: '' }))

vi.mock('electron', () => ({
  app: {
    setName: vi.fn(), setAppUserModelId: vi.fn(), setPath: vi.fn(),
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getPath: () => state.directory, on: vi.fn(), exit: vi.fn(), quit: vi.fn()
  },
  dialog: { showErrorBox: vi.fn() },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn() } },
  BrowserWindow: vi.fn(), Menu: {}, nativeTheme: {}, shell: {}
}))
vi.mock('../src/main/backup/service', () => ({ BackupService: vi.fn() }))
vi.mock('../src/main/sessions', () => ({ SessionHub: vi.fn(), seedDemo: vi.fn() }))
vi.mock('../src/main/ipc', () => ({ registerIpc: vi.fn() }))
vi.mock('../src/main/secrets', () => ({
  createSafeCodec: () => ({ encrypt: (value: string) => value, decrypt: (value: string) => value })
}))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

import { app, BrowserWindow, dialog } from 'electron'
import { BackupService } from '../src/main/backup/service'
import { logError } from '../src/main/logger'

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-startup-version-'))
})
afterEach(() => {
  fs.rmSync(state.directory, { recursive: true, force: true })
})

describe('startup version error through the real entry point and store reader', () => {
  it('shows the upgrade message and data path before exiting, without touching the newer store', async () => {
    const filePath = path.join(state.directory, 'hopline-store.json')
    const contents = JSON.stringify({ version: 10, hosts: [{ future: true }], groups: [] }, null, 2)
    fs.writeFileSync(filePath, contents)
    fs.utimesSync(filePath, 123456, 123456)
    const before = fs.statSync(filePath)

    await import('../src/main/index')
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(1))

    expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      '无法打开主机库',
      `数据文件来自更新版本的 HopLine，当前版本无法打开。请安装最新版本后再试。\n\n数据文件未做任何修改：${filePath}`
    )
    expect(vi.mocked(dialog.showErrorBox).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(app.exit).mock.invocationCallOrder[0]!)
    expect(logError).toHaveBeenCalledWith('startup failed', expect.objectContaining({ name: 'NewerVersionError', filePath }))
    expect(fs.readFileSync(filePath, 'utf8')).toBe(contents)
    const after = fs.statSync(filePath)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
    expect(fs.existsSync(`${filePath}.v1.bak`)).toBe(false)
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false)
    expect(fs.readdirSync(state.directory)).toEqual(['hopline-store.json'])
    expect(BackupService).not.toHaveBeenCalled()
    expect(BrowserWindow).not.toHaveBeenCalled()
  })

  it('keeps the existing exit behavior for other startup failures without showing the version dialog', async () => {
    // A directory at the store path produces a real read error, not a version error.
    const filePath = path.join(state.directory, 'hopline-store.json')
    fs.mkdirSync(filePath)

    await import('../src/main/index')
    await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(1))

    expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(dialog.showErrorBox).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('startup failed', expect.any(Error))
    expect(fs.statSync(filePath).isDirectory()).toBe(true)
    expect(fs.readdirSync(state.directory)).toEqual(['hopline-store.json'])
    expect(BackupService).not.toHaveBeenCalled()
    expect(BrowserWindow).not.toHaveBeenCalled()
  })
})
