import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  on: vi.fn(), removeListener: vi.fn(), quit: vi.fn(), metrics: vi.fn(),
  expose: vi.fn(), send: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getAppMetrics: mock.metrics, quit: mock.quit },
  ipcMain: { on: mock.on, removeListener: mock.removeListener },
  contextBridge: { exposeInMainWorld: mock.expose }, ipcRenderer: { send: mock.send }
}))

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process, 'uptime').mockReturnValue(0.5)
  mock.metrics.mockReturnValue([{ memory: { workingSetSize: 1024 } }, { memory: { workingSetSize: 3072 } }])
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each([undefined, '0', 'true'])('does nothing when HOPLINE_PERF=%s', async (flag) => {
  vi.stubEnv('HOPLINE_PERF', flag)
  const { perfPreferences, registerPerf } = await import('../src/main/perf')
  expect(perfPreferences()).toEqual({})
  registerPerf({} as BrowserWindow)
  vi.advanceTimersByTime(60_000)
  expect(mock.on).not.toHaveBeenCalled()
  expect(mock.metrics).not.toHaveBeenCalled()
  expect(mock.quit).not.toHaveBeenCalled()
  expect(console.log).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('only accepts the main window frame, samples every process after 10 seconds and quits normally', async () => {
  vi.stubEnv('HOPLINE_PERF', '1')
  const { perfPreferences, registerPerf } = await import('../src/main/perf')
  const webContents = { mainFrame: {} }
  const win = Object.assign(new EventEmitter(), { webContents })
  expect(perfPreferences()).toEqual({ additionalArguments: ['--hopline-perf'] })
  registerPerf(win as unknown as BrowserWindow)
  const [channel, handler] = mock.on.mock.calls[0]
  expect(channel).toBe('perf:first-paint')
  handler({ sender: {}, senderFrame: webContents.mainFrame })
  handler({ sender: webContents, senderFrame: {} })
  expect(console.log).not.toHaveBeenCalled()
  vi.advanceTimersByTime(150)
  handler({ sender: webContents, senderFrame: webContents.mainFrame })
  expect(mock.removeListener).toHaveBeenCalledWith(channel, handler)
  expect(console.log).toHaveBeenCalledWith('HOPLINE_PERF_FIRST_PAINT')
  vi.advanceTimersByTime(9999)
  expect(mock.metrics).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(mock.metrics).toHaveBeenCalledTimes(1)
  expect(console.log).toHaveBeenLastCalledWith('HOPLINE_PERF {"coldStartMs":500,"firstPaintMs":150,"idleMemoryMB":4}')
  expect(mock.quit).toHaveBeenCalledTimes(1)
})

it('cleans up the timer and IPC if the window closes before sampling', async () => {
  vi.stubEnv('HOPLINE_PERF', '1')
  const { registerPerf } = await import('../src/main/perf')
  const webContents = { mainFrame: {} }
  const win = Object.assign(new EventEmitter(), { webContents })
  registerPerf(win as unknown as BrowserWindow)
  mock.on.mock.calls[0][1]({ sender: webContents, senderFrame: webContents.mainFrame })
  win.emit('closed')
  vi.advanceTimersByTime(10_000)
  expect(mock.removeListener).toHaveBeenCalledWith('perf:first-paint', expect.any(Function))
  expect(mock.metrics).not.toHaveBeenCalled()
  expect(mock.quit).not.toHaveBeenCalled()
})

it.each([false, true])('only exposes the one-shot preload bridge with the main-process flag: %s', async (enabled) => {
  vi.spyOn(process, 'argv', 'get').mockReturnValue(enabled ? ['electron', '--hopline-perf'] : ['electron'])
  await import('../src/preload/index')
  const bridge = mock.expose.mock.calls.find(([name]) => name === 'hoplinePerf')
  if (!enabled) {
    expect(bridge).toBeUndefined()
    expect(mock.send).not.toHaveBeenCalled()
  } else {
    bridge![1](); bridge![1]()
    expect(mock.send).toHaveBeenCalledTimes(1)
    expect(mock.send).toHaveBeenCalledWith('perf:first-paint')
  }
})

it.each([undefined, '0', 'true'])('does not enable trace from its argument without HOPLINE_PERF=1 (%s)', async flag => {
  vi.stubEnv('HOPLINE_PERF', flag)
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['electron', '--hopline-perf-trace'])
  const { perfStage, perfPreferences, registerPerf } = await import('../src/main/perf')
  perfStage('main-entry'); registerPerf({} as BrowserWindow)
  expect(perfPreferences()).toEqual({})
  expect(console.log).not.toHaveBeenCalled(); expect(mock.on).not.toHaveBeenCalled()
})

it('keeps stage logging and the stage channel absent during ordinary performance measurement', async () => {
  vi.stubEnv('HOPLINE_PERF', '1')
  const { perfStage, registerPerf } = await import('../src/main/perf')
  const win = Object.assign(new EventEmitter(), { webContents: { mainFrame: {} } })
  perfStage('main-entry'); registerPerf(win as unknown as BrowserWindow)
  expect(mock.on.mock.calls.map(([channel]) => channel)).toEqual(['perf:first-paint'])
  expect(console.log).not.toHaveBeenCalled()
})

it('traces process uptime once per stage and only accepts fixed stages from the current main frame', async () => {
  vi.stubEnv('HOPLINE_PERF', '1')
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['electron', '--hopline-perf-trace'])
  const { perfStage, perfPreferences, registerPerf } = await import('../src/main/perf')
  const webContents = { mainFrame: {} }, win = Object.assign(new EventEmitter(), { webContents })
  expect(perfPreferences()).toEqual({ additionalArguments: ['--hopline-perf', '--hopline-perf-trace'] })
  perfStage('main-entry'); perfStage('main-entry'); perfStage('invalid\nstage')
  expect(console.log).toHaveBeenCalledExactlyOnceWith('HOPLINE_PERF_STAGE {"name":"main-entry","uptimeMs":500}')
  registerPerf(win as unknown as BrowserWindow)
  const stage = mock.on.mock.calls.find(([channel]) => channel === 'perf:stage')![1]
  const valid = { sender: webContents, senderFrame: webContents.mainFrame }
  stage({ sender: {}, senderFrame: webContents.mainFrame }, 'renderer-entry')
  stage({ sender: webContents, senderFrame: {} }, 'renderer-entry')
  stage(valid, 'arbitrary'); stage(valid, 'first-paint'); stage(valid, { name: 'renderer-entry' })
  stage(valid, 'renderer-entry', { arbitrary: 'payload' })
  expect(console.log).toHaveBeenCalledTimes(1)
  vi.mocked(process.uptime).mockReturnValue(0.65)
  stage(valid, 'renderer-entry'); stage(valid, 'renderer-entry')
  expect(console.log).toHaveBeenLastCalledWith('HOPLINE_PERF_STAGE {"name":"renderer-entry","uptimeMs":650}')
  vi.mocked(process.uptime).mockReturnValue(0.7)
  stage(valid, 'catalog-ready')
  expect(console.log).toHaveBeenLastCalledWith('HOPLINE_PERF_STAGE {"name":"catalog-ready","uptimeMs":700}')
  expect(console.log).toHaveBeenCalledTimes(3)
  expect(mock.metrics).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  win.emit('closed')
  expect(mock.removeListener).toHaveBeenCalledWith('perf:stage', stage)
})

it.each([
  [[], false], [['--hopline-perf'], false], [['--hopline-perf-trace'], false],
  [['--hopline-perf', '--hopline-perf-trace'], true]
] as const)('only exposes restricted stage notifications when both preload flags are present: %s', async (args, enabled) => {
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['electron', ...args])
  await import('../src/preload/index')
  const bridge = mock.expose.mock.calls.find(([name]) => name === 'hoplinePerfStage')
  if (!enabled) { expect(bridge).toBeUndefined(); return }
  const notify = bridge![1]
  notify('arbitrary'); notify('first-paint'); notify({ name: 'renderer-entry' })
  notify('renderer-entry', { arbitrary: 'payload' })
  expect(mock.send).not.toHaveBeenCalled()
  notify('renderer-entry'); notify('renderer-entry'); notify('catalog-ready'); notify('catalog-ready')
  expect(mock.send.mock.calls).toEqual([['perf:stage', 'renderer-entry'], ['perf:stage', 'catalog-ready']])
})
