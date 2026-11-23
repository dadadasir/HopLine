import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import type { IpcDeps } from '../src/main/ipc'
import { parseSecurity } from '../src/core/security/parse'
import { evaluate } from '../src/core/security/rules'
const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), handle: vi.fn(), on: vi.fn(), load: vi.fn(), capture: vi.fn(), destroy: vi.fn(), save: vi.fn(), write: vi.fn(), window: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on }, webUtils: {},
  ipcMain: { handle: mocks.handle, on: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true },
  BrowserWindow: class { constructor(options: unknown) { mocks.window(options) } loadURL = mocks.load; destroy = mocks.destroy; webContents = { executeJavaScript: vi.fn(async () => undefined), capturePage: mocks.capture } },
  ClipboardItem: class { constructor(readonly items: unknown) {} }, clipboard: { write: mocks.write }, dialog: { showSaveDialog: mocks.save }
}))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi
let directory: string
beforeEach(() => { vi.clearAllMocks(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-security-ipc-')) })
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
const handler = (channel: string) => mocks.handle.mock.calls.find(([name]) => name === channel)![1]
function setup() {
  const snapshot = parseSecurity(fs.readFileSync(new URL('./fixtures/security/unsafe.txt', import.meta.url), 'utf8'), Date.UTC(2026, 9, 27))
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  const security = { check: vi.fn(), latest: vi.fn(() => ({ snapshot, results: evaluate(snapshot), score: 0, ignores: {} })), ignore: vi.fn(), prune: vi.fn() }
  registerIpc({ getWindow: () => win, security, shots: false, vault: { snapshot: () => ({ settings: { language: 'zh' } }), getHost: vi.fn(() => ({ host: '192.0.2.1' })), deleteHost: vi.fn() }, save: vi.fn(), sessions: { closeHost: vi.fn(async () => {}), pool: { invalidate: vi.fn(), invalidateAll: vi.fn() } }, backup: { scheduleAuto: vi.fn(), importFrom: vi.fn(), webdav: vi.fn() } } as unknown as IpcDeps)
  return { security, event: { sender: win.webContents } }
}
it('forwards all security calls through preload', async () => {
  await bridge.security.check('h', { sudoPassword: 'pw' }); await bridge.security.latest('h')
  await bridge.security.ignore('h', 'firewall-off', 'note'); await bridge.security.unignore('h', 'firewall-off'); await bridge.security.share('h', { host: true })
  expect(mocks.invoke.mock.calls).toEqual([['security:check', 'h', { sudoPassword: 'pw' }], ['security:latest', 'h'], ['security:ignore', 'h', 'firewall-off', 'note'], ['security:unignore', 'h', 'firewall-off'], ['security:share', 'h', { host: true }]])
})
it('guards channels, rejects unexpected payloads, and prunes on host deletion/import', async () => {
  const { security, event } = setup()
  for (const name of ['check', 'latest', 'ignore', 'unignore']) expect(() => handler(`security:${name}`)({ sender: {} }, 'h')).toThrow('拒绝')
  await expect(handler('security:share')({ sender: {} }, 'h')).rejects.toThrow('拒绝')
  for (const options of [null, [], { command: 'evil' }]) expect(() => handler('security:check')(event, 'h', options)).toThrow('invalid')
  for (const options of [null, [], { command: 'evil' }, { host: 'true' }, { host: 1 }, { host: null }]) await expect(handler('security:share')(event, 'h', options)).rejects.toThrow('invalid')
  expect(() => handler('security:ignore')(event, 'h', 'rule', null)).toThrow('invalid')
  expect(security.check).not.toHaveBeenCalled()
  handler('hosts:delete')(event, 'h'); await handler('backup:import')(event, '/tmp/x', null, 'replace'); await handler('backup:webdav')(event, 'pull', null, 'replace', 'restore-request')
  expect(security.prune).toHaveBeenCalledTimes(3)
})
it.each([undefined, false, true])('captures an isolated summary with host opt-in %s, saves PNG and writes image/png only', async (showHost) => {
  const { event } = setup(), file = path.join(directory, 'share.png')
  mocks.save.mockResolvedValue({ filePath: file, canceled: false }); mocks.load.mockResolvedValue(undefined)
  const png = Buffer.from('png bytes'), image = { resize: vi.fn().mockReturnThis(), toPNG: () => png }
  mocks.capture.mockResolvedValue(image); mocks.write.mockResolvedValue(undefined)
  await expect(handler('security:share')(event, 'h', showHost === undefined ? undefined : { host: showHost })).resolves.toBe(file)
  const html = decodeURIComponent(mocks.load.mock.calls[0][0].split(',')[1])
  expect(html).not.toMatch(/example.com|192\.0\.2|xmrig|guest|backup|sshd/)
  expect(html.includes('192.***.***.1')).toBe(showHost === true)
  expect(mocks.window).toHaveBeenCalledWith(expect.objectContaining({ width: 1200, height: 630, show: false }))
  expect(mocks.capture).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 630 })
  expect(fs.readFileSync(file)).toEqual(png)
  const items = mocks.write.mock.calls[0][0][0].items
  expect(Object.keys(items)).toEqual(['image/png'])
  expect(await items['image/png'].arrayBuffer()).toEqual(png.buffer.slice(png.byteOffset, png.byteOffset + png.length))
  expect(mocks.destroy).toHaveBeenCalledOnce()
})
it('does not capture on cancellation and destroys a failed capture window', async () => {
  const { event } = setup()
  mocks.save.mockResolvedValueOnce({ canceled: true })
  await expect(handler('security:share')(event, 'h')).resolves.toBeNull(); expect(mocks.window).not.toHaveBeenCalled()
  mocks.save.mockResolvedValueOnce({ canceled: false, filePath: path.join(directory, 'card.png') }); mocks.load.mockRejectedValueOnce(new Error('render failed'))
  await expect(handler('security:share')(event, 'h')).rejects.toThrow('render failed'); expect(mocks.destroy).toHaveBeenCalledOnce()
})
