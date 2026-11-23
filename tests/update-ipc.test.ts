import { beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import type { IpcDeps } from '../src/main/ipc'
const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn(), openExternal: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke }, webUtils: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() }, shell: { openExternal: mocks.openExternal }, safeStorage: { isEncryptionAvailable: () => true } }))
import '../src/preload/index'
import { isAppEvent, registerIpc } from '../src/main/ipc'
import { hopEvents } from '../src/shared/api'
const api = mocks.expose.mock.calls[0][1] as HoplineApi
const url = 'https://github.com/dadadasir/HopLine/releases/tag/v0.4.0'
beforeEach(() => vi.clearAllMocks())

it('exposes only fixed update operations, with no request URL or user information on check', async () => {
  await api.updates.preferences(); await api.updates.setAutomatic(false); await api.updates.check(); await api.updates.openRelease(url)
  expect(mocks.invoke.mock.calls).toEqual([['updates:preferences'], ['updates:setAutomatic', false], ['updates:check'], ['updates:openRelease', url]])
  expect(hopEvents).toContain('updates:available')
  expect(isAppEvent('updates:available')).toBe(true)
})

it('guards update preferences and checks, validates booleans, and only opens an official release URL', async () => {
  const win = { isDestroyed: () => false, webContents: {} }
  const preferences = { automatic: true, lastAttemptAt: null }
  const result = { status: 'available', release: { url, version: '0.4.0', summary: '<img src=x onerror=alert(1)>' } }
  const updates = { preferences: vi.fn(() => preferences), setAutomatic: vi.fn(() => ({ ...preferences, automatic: false })), check: vi.fn(async () => result) }
  registerIpc({ getWindow: () => win, updates } as unknown as IpcDeps)
  const handler = (name: string) => mocks.handle.mock.calls.find(([channel]) => channel === `updates:${name}`)![1]
  const event = { sender: win.webContents }
  for (const name of ['preferences','setAutomatic','check']) expect(() => handler(name)({ sender: {} }, false)).toThrow('拒绝')
  expect(updates.check).not.toHaveBeenCalled()
  expect(handler('preferences')(event)).toEqual(preferences)
  for (const value of ['false', null, 0, {}]) expect(() => handler('setAutomatic')(event, value)).toThrow('不合法')
  expect(handler('setAutomatic')(event, false).automatic).toBe(false)
  expect(updates.setAutomatic).toHaveBeenCalledExactlyOnceWith(false)
  expect(await handler('check')(event)).toEqual(result)
  expect(updates.check).toHaveBeenCalledExactlyOnceWith(true)
  await expect(handler('openRelease')({ sender: {} }, url)).rejects.toThrow('拒绝')
  for (const target of [null, 1, 'http://github.com/dadadasir/HopLine/releases/tag/v0.4.0', 'https://github.com.evil.test/dadadasir/HopLine/releases/tag/v0.4.0', 'https://github.com/other/repo/releases/tag/v0.4.0', `${url}?token=secret`, 'javascript:alert(1)', 'file:///tmp/a']) {
    await expect(handler('openRelease')(event, target)).rejects.toThrow('不合法')
  }
  expect(mocks.openExternal).not.toHaveBeenCalled()
  await handler('openRelease')(event, url)
  expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url)
})
