import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'

const mocks = vi.hoisted(() => ({
  expose: vi.fn(), invoke: vi.fn(), handle: vi.fn(),
  list: vi.fn(), save: vi.fn(), delete: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke },
  webUtils: {}, BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true }
}))
vi.mock('../src/main/snippets', () => ({ listSnippets: mocks.list, saveSnippet: mocks.save, deleteSnippet: mocks.delete }))
import '../src/preload/index'
import { registerIpc, type IpcDeps } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi

beforeEach(() => { vi.clearAllMocks() })

describe('snippets IPC', () => {
  it('only exposes the three declared channels and forwards inputs unchanged', async () => {
    const input = { name: 'Test', command: 'echo {{value}}\n', hostId: null }
    await bridge.snippets.list()
    await bridge.snippets.save(input)
    await bridge.snippets.delete('snippet-id')
    expect(mocks.invoke.mock.calls).toEqual([
      ['snippets:list'], ['snippets:save', input], ['snippets:delete', 'snippet-id']
    ])
  })

  it.each(['list', 'save', 'delete'] as const)('guards snippets:%s before touching storage', (operation) => {
    const win = { isDestroyed: () => false, webContents: {} }
    const vaultSave = vi.fn()
    const backup = { scheduleAuto: vi.fn() }
    registerIpc({ getWindow: () => win, save: vaultSave, backup, shots: false } as unknown as IpcDeps)
    const handler = mocks.handle.mock.calls.find(([name]) => name === `snippets:${operation}`)![1]
    expect(() => handler({ sender: {} }, 'input')).toThrow('拒绝的调用方')
    expect(mocks[operation]).not.toHaveBeenCalled()
    mocks[operation].mockReturnValue('result')
    handler({ sender: win.webContents }, 'input')
    expect(mocks[operation].mock.calls).toEqual(operation === 'list' ? [[]] : [['input']])
    expect(vaultSave).not.toHaveBeenCalled()
    expect(backup.scheduleAuto).not.toHaveBeenCalled()
  })
})
