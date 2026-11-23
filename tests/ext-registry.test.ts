import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { MainExtContext, MainExtension } from '../src/ext/api'
import type { HostPublic } from '../src/shared/types'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { mergeRendererExtensions, extensionPaletteActions, type RendererExtension } from '../src/renderer/src/ext/registry'
import { moveSelection, paletteItems } from '../src/renderer/src/logic/palette'
import fixture from './fixtures/pro-ext/main'

vi.mock('electron', () => ({
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, ipcMain: {},
  safeStorage: { isEncryptionAvailable: () => true }
}))
import { registerMainExtensions, type MainRegistryDeps } from '../src/main/ext/registry'
import { makeCallerGuard } from '../src/main/ipc'

afterEach(() => vi.restoreAllMocks())

const label = { zh: '扩展操作', en: 'Extension action' }
const entry = (id: string): RendererExtension => ({
  id,
  sidebarItems: [{ id: 'sidebar', label, open: vi.fn() }],
  settingsPages: [{ id: 'settings', label, render: () => null }],
  paletteActions: [{ id: 'action', label, keywords: ['needle'], run: vi.fn() }]
})

describe('renderer extension registry', () => {
  it('returns no contributions or warnings for the community edition', () => {
    expect(mergeRendererExtensions([])).toEqual({ sidebarItems: [], pages: [], settingsPages: [], paletteActions: [], warnings: [] })
  })

  it('merges in order, preserves the first contribution per id, and does not mutate inputs', () => {
    const first = entry('first')
    const second = entry('second')
    second.sidebarItems!.push({ id: 'unique', label, open: vi.fn() })
    const inputs = [first, second]
    const before = inputs.map((ext) => ({ ...ext, sidebarItems: [...ext.sidebarItems!] }))
    const result = mergeRendererExtensions(inputs)
    expect(inputs).toEqual(before)
    expect(result.sidebarItems).toEqual([first.sidebarItems![0], second.sidebarItems![1]])
    expect(result.settingsPages).toEqual(first.settingsPages)
    expect(result.paletteActions).toEqual(first.paletteActions)
    expect(result.warnings).toHaveLength(3)
    expect(mergeRendererExtensions(inputs)).toEqual(result)
  })

  it('skips repeated extension ids and allows the same item id in different slots', () => {
    const first = entry('first')
    first.settingsPages![0].id = 'sidebar'
    const repeated = { id: 'first', sidebarItems: [{ id: 'unused', label, open() {} }] }
    const result = mergeRendererExtensions([first, repeated])
    expect(result.sidebarItems).toEqual(first.sidebarItems)
    expect(result.settingsPages).toEqual(first.settingsPages)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('Duplicate extension id')
  })

  it('adds localized searchable actions with distinct ids and preserves keyboard navigation', () => {
    const registry = mergeRendererExtensions([entry('first')])
    const hosts: Pick<HostPublic, 'id' | 'name' | 'host' | 'username'>[] = [
      { id: 'action', name: 'Host', host: 'example.test', username: 'root' }
    ]
    const actions = [{ id: 'action', label: 'Core', run() {} }, ...extensionPaletteActions(registry, 'zh', vi.fn())]
    const items = paletteItems(hosts, actions, '')
    expect(items.map((item) => item.id)).toEqual(['host:action', 'action:action', 'action:pro:action'])
    expect(moveSelection(1, 1, items.length)).toBe(2)
    expect(moveSelection(2, 1, items.length)).toBe(2)
    expect(moveSelection(2, -1, items.length)).toBe(1)
    expect(paletteItems(hosts, actions, ' NEEDLE ')).toHaveLength(1)
    expect(paletteItems(hosts, actions, '扩展')).toHaveLength(1)
    expect(extensionPaletteActions(registry, 'en', vi.fn())[0].label).toBe('Extension action')
  })

  it.each([false, true])('handles extension action errors (async=%s)', async (async) => {
    const error = new Error('extension failed')
    const run = async ? () => Promise.reject(error) : () => { throw error }
    const onError = vi.fn()
    extensionPaletteActions(mergeRendererExtensions([{ id: 'failure', paletteActions: [{ id: 'fail', label, run }] }]), 'zh', onError)[0].run()
    await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(error))
  })
})

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow
  let current: BrowserWindow | null = win
  const deps: MainRegistryDeps = {
    ipc: {
      handle(channel, handler) {
        if (handlers.has(channel)) throw new Error(`already registered: ${channel}`)
        handlers.set(channel, handler)
      },
      removeHandler: (channel) => { handlers.delete(channel) }
    },
    getWindow: () => current,
    userData: '/tmp/hopline-test',
    listHosts: () => [],
    log: { info: vi.fn(), error: vi.fn() }
  }
  return {
    deps, win, handlers,
    setWindow: (value: BrowserWindow | null) => { current = value },
    event: { sender: win.webContents } as IpcMainInvokeEvent
  }
}

describe('main extension registry', () => {
  it('runs the fixture and normalizes short and explicit pro channels without passing the Electron event', async () => {
    const { deps, handlers, event } = harness()
    const echo = vi.fn((...args: unknown[]) => args)
    await registerMainExtensions([...fixture, { id: 'extra', setup: (ctx) => ctx.handle('pro:echo', echo) }], deps)
    expect(handlers.get('pro:ping')!(event)).toBe('pong')
    expect(handlers.get('pro:echo')!(event, 'hello', 3)).toEqual(['hello', 3])
    expect(echo).toHaveBeenCalledWith('hello', 3)
    expect(deps.log.info).toHaveBeenCalledWith('HOPLINE_PRO_FIXTURE_MARKER')
  })

  it('rejects duplicate channels across and within extensions', async () => {
    const { deps, handlers, event } = harness()
    await registerMainExtensions([
      { id: 'first', setup(ctx) {
        ctx.handle('ping', () => 'first')
        expect(() => ctx.handle('pro:ping', () => 'duplicate')).toThrow('Duplicate extension channel')
      } },
      { id: 'second', setup: (ctx) => ctx.handle('ping', () => 'second') }
    ], deps)
    expect(handlers.get('pro:ping')!(event)).toBe('first')
    expect(deps.log.error).toHaveBeenCalledTimes(1)
  })

  it.each(['', 'ssh:connect', 'pro:', 'pro:ssh:connect', '../ping'])('rejects invalid or core channel %s', async (name) => {
    const { deps, handlers } = harness()
    await registerMainExtensions([{ id: 'bad', setup(ctx) { ctx.handle(name, () => null) } }], deps)
    expect(handlers.size).toBe(0)
    expect(deps.log.error).toHaveBeenCalledTimes(1)
  })

  it('awaits setup in order, rolls back failed registration, and continues after sync and async errors', async () => {
    const { deps, handlers, event } = harness()
    const order: string[] = []
    let failed!: MainExtContext
    const extensions: MainExtension[] = [
      { id: 'sync-fail', setup() { order.push('sync'); throw new Error('sync') } },
      { id: 'async-fail', async setup(ctx) {
        failed = ctx
        ctx.handle('ping', () => 'failed')
        await Promise.resolve()
        order.push('async')
        throw new Error('async')
      } },
      { id: 'last', setup(ctx) { order.push('last'); ctx.handle('ping', () => 'last') } }
    ]
    await expect(registerMainExtensions(extensions, deps)).resolves.toBeUndefined()
    expect(order).toEqual(['sync', 'async', 'last'])
    expect(handlers.get('pro:ping')!(event)).toBe('last')
    expect(deps.log.error).toHaveBeenCalledTimes(2)
    expect(() => failed.handle('late', () => null)).toThrow('inactive')
    failed.emit('late', {})
    expect(deps.getWindow()!.webContents.send).not.toHaveBeenCalled()
  })

  it('uses the same caller guard as core IPC and follows window replacement', async () => {
    const h = harness()
    const handler = vi.fn(() => 'pong')
    await registerMainExtensions([{ id: 'guard', setup: (ctx) => ctx.handle('ping', handler) }], h.deps)
    const invoke = h.handlers.get('pro:ping')!
    const coreGuard = makeCallerGuard(h.deps.getWindow)
    invoke(h.event)
    for (const current of [null, { isDestroyed: () => true, webContents: h.win.webContents } as BrowserWindow]) {
      h.setWindow(current)
      expect(() => coreGuard(h.event)).toThrow('拒绝的调用方')
      expect(() => invoke(h.event)).toThrow('拒绝的调用方')
    }
    const replacement = { isDestroyed: () => false, webContents: {} } as BrowserWindow
    h.setWindow(replacement)
    expect(() => invoke(h.event)).toThrow('拒绝的调用方')
    const event = { sender: replacement.webContents } as IpcMainInvokeEvent
    expect(() => coreGuard(event)).not.toThrow()
    expect(invoke(event)).toBe('pong')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('emits enveloped events only to the live window and supplies isolated public host snapshots', async () => {
    const h = harness()
    const vault = new Vault(emptyStore(), new MemorySecretCodec())
    vault.saveHost({ groupId: null, name: 'host', host: 'example.test', port: 22, username: 'user', authType: 'password', password: 'secret-value' })
    h.deps.listHosts = () => vault.listHosts()
    let ctx!: MainExtContext
    await registerMainExtensions([{ id: 'context', setup(value) { ctx = value } }], h.deps)
    expect(ctx.edition).toBe('pro')
    expect(ctx.userData).toBe(h.deps.userData)
    const hosts = ctx.listHosts()
    expect(JSON.stringify(hosts)).not.toContain('secret-value')
    hosts[0].name = 'changed'
    expect(ctx.listHosts()[0].name).toBe('host')
    ctx.emit('ready', { ok: true })
    expect(h.win.webContents.send).toHaveBeenCalledExactlyOnceWith('pro:event', { type: 'ready', payload: { ok: true } })
    h.setWindow(null)
    expect(() => ctx.emit('closed', null)).not.toThrow()
    expect(h.win.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('skips repeated extension ids before setup', async () => {
    const { deps } = harness()
    const setup = vi.fn()
    await registerMainExtensions([{ id: 'same', setup }, { id: 'same', setup }], deps)
    expect(setup).toHaveBeenCalledTimes(1)
    expect(deps.log.error).toHaveBeenCalledTimes(1)
  })
})

it('rolls back extension services and disposers on setup failure, and denies stale contexts', async () => {
  const { deps } = harness()
  let context!: MainExtContext
  const dispose = vi.fn(), execute = vi.fn(), capabilities = vi.fn()
  deps.services = { version: '0.3.0', language: () => 'zh', listGroups: () => [], listSnippets: () => [], sudoMode: async () => 'root', execute, appendOperation: vi.fn(), setCapabilities: capabilities }
  await registerMainExtensions([{ id: 'failure', setup(ctx) {
    context = ctx
    ctx.onDispose(dispose)
    ctx.setCapabilities({ overviewHostLimit: Infinity })
    throw new Error('setup failed')
  } }], deps)
  expect(dispose).toHaveBeenCalledOnce()
  expect(capabilities.mock.calls).toEqual([[{ overviewHostLimit: Infinity }], [{ overviewHostLimit: 5 }]])
  expect(() => context.execute('host', { command: 'id', sudo: false, timeoutMs: 1000 })).toThrow('已停用')
  expect(execute).not.toHaveBeenCalled()
})
it('disposes a loaded extension once while exposing copied catalog data and shared service operations', async () => {
  const { deps } = harness()
  const groups = [{ id: 'one', name: '组', sortOrder: 0, updatedAt: 1 }], execute = vi.fn()
  let cleanup!: () => void, context!: MainExtContext
  const callback = vi.fn()
  deps.onDispose = value => { cleanup = value }
  deps.services = { version: '0.3.0', language: () => 'en', listGroups: () => groups, listSnippets: () => [], sudoMode: async () => 'root', execute, appendOperation: vi.fn(), setCapabilities: vi.fn() }
  await registerMainExtensions([{ id: 'loaded', setup(ctx) { context = ctx; ctx.onDispose(callback) } }], deps)
  const copy = context.listGroups(); copy[0].name = 'changed'
  expect(groups[0].name).toBe('组')
  expect(context.language()).toBe('en')
  expect(context.version).toBe('0.3.0')
  cleanup(); cleanup()
  expect(callback).toHaveBeenCalledOnce()
  expect(() => context.listHosts()).toThrow('已停用')
})

it('isolates extension credential owners and disposes observation/runtime subscriptions', async () => {
  const { deps } = harness(), vault = new Vault(emptyStore(), new MemorySecretCodec())
  const values: MainExtContext[] = [], offs = [vi.fn(), vi.fn()]
  let stop!: () => void
  deps.onDispose = callback => { stop = callback }
  deps.services = {
    version: '0.3.0', language: () => 'zh', listGroups: () => [], listSnippets: () => [], sudoMode: async () => 'root', execute: vi.fn(), appendOperation: vi.fn(), setCapabilities: vi.fn(),
    secretsFor: owner => ({ has: slot => vault.extensionSecretHas(owner, slot), get: slot => vault.extensionSecretGet(owner, slot), set: (slot, value) => vault.extensionSecretSet(owner, slot, value) }),
    observations: () => ({ records: {}, security: {} }), onObservations: () => offs[0],
    runtime: () => ({ windowOpen: false, backgroundStay: true }), onRuntime: () => offs[1]
  }
  await registerMainExtensions([{ id: 'first', setup: ctx => { values.push(ctx); ctx.secrets!.set('credential', 'isolated') } }, { id: 'second', setup: ctx => { values.push(ctx); ctx.onObservations!(() => {}); ctx.onRuntime!(() => {}) } }], deps)
  expect(values[0].secrets!.get('credential')).toBe('isolated')
  expect(values[1].secrets!.get('credential')).toBeNull()
  expect(values[1].runtime!()).toEqual({ windowOpen: false, backgroundStay: true })
  stop()
  expect(offs[0]).toHaveBeenCalledOnce(); expect(offs[1]).toHaveBeenCalledOnce()
  expect(() => values[1].secrets!.get('credential')).toThrow('已停用')
})
