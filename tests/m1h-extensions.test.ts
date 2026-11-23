import { afterEach, expect, it, vi } from 'vitest'
import type { MainExtContext } from '../src/ext/api'
import type { MainRegistryDeps } from '../src/main/ext/registry'
const mocks = vi.hoisted(() => ({ error: vi.fn(), setup: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, app: {} }))
vi.mock('../src/main/ipc', () => ({ makeCallerGuard: () => () => {} }))
vi.mock('../src/main/logger', () => ({ logError: mocks.error, logInfo: vi.fn() }))
vi.mock('@hopline/pro-main', () => { throw new Error('main import exploded') })
vi.mock('@hopline/pro-renderer', () => { throw new Error('renderer import exploded') })
import { registerMainExtensions } from '../src/main/ext/registry'
import { loadMainExtensions } from '../src/main/ext'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks() })
function harness() {
  const handlers = new Map<string, unknown>()
  const deps: MainRegistryDeps = {
    ipc: { handle: (name, fn) => { handlers.set(name, fn) }, removeHandler: (name) => { handlers.delete(name) } },
    getWindow: () => null, userData: '/tmp/test', listHosts: () => [], log: { error: mocks.error, info() {} }
  }
  return { handlers, deps }
}
it('times setup out at 10 seconds, rolls back owned handlers and rejects late registration', async () => {
  vi.useFakeTimers()
  const { handlers, deps } = harness()
  let late!: MainExtContext
  let finish!: () => void
  const done = registerMainExtensions([
    { id: 'hung', setup(ctx) { late = ctx; ctx.handle('ping', () => 'old'); return new Promise<void>((r) => { finish = r }) } },
    { id: 'next', setup(ctx) { mocks.setup(); ctx.handle('ping', () => 'next') } }
  ], deps)
  await vi.advanceTimersByTimeAsync(9999)
  expect(mocks.setup).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await done
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('hung'), expect.objectContaining({ message: expect.stringContaining('10s') }))
  expect(mocks.setup).toHaveBeenCalledOnce()
  expect((handlers.get('pro:ping') as () => string)()).toBe('next')
  expect(() => late.handle('late', () => null)).toThrow('inactive')
  finish()
  await Promise.resolve()
  expect(vi.getTimerCount()).toBe(0)
})
it.each(['A', 'pro:Upper', 'bad space', 'bad/part', 'a'.repeat(61), `pro:${'a'.repeat(61)}`])('rejects unsafe or overlong final channel %s', async (name) => {
  const { handlers, deps } = harness()
  await registerMainExtensions([{ id: 'bad', setup: (ctx) => ctx.handle(name, () => null) }], deps)
  expect(handlers.size).toBe(0)
  expect(mocks.error).toHaveBeenCalledOnce()
})
it('accepts a 64-character final channel and the existing punctuation', async () => {
  const { handlers, deps } = harness()
  await registerMainExtensions([{ id: 'valid', setup(ctx) {
    ctx.handle('a'.repeat(60), () => null)
    ctx.handle('pro:a.b_c-d', () => null)
  } }], deps)
  expect([...handlers.keys()]).toEqual([`pro:${'a'.repeat(60)}`, 'pro:a.b_c-d'])
  expect(mocks.error).not.toHaveBeenCalled()
})
it('logs a main entrypoint import failure without rejecting startup', async () => {
  await expect(loadMainExtensions(() => null, '/tmp/test', () => [])).resolves.toBeUndefined()
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('import failed'), expect.any(Error))
})
it('logs a renderer entrypoint import failure and keeps an empty usable registry', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const module = await import('../src/renderer/src/ext')
  await expect(module.extensionsReady).resolves.toBeUndefined()
  expect(module.rendererExtensions.settingsPages).toEqual([])
  expect(log).toHaveBeenCalledWith(expect.stringContaining('import failed'), expect.any(Error))
})
