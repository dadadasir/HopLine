import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
const mock = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), metrics: vi.fn(() => [{ pid: 123, memory: { workingSetSize: 456 } }]) }))
vi.mock('electron', () => ({ app: { getAppMetrics: mock.metrics } }))
vi.mock('../src/main/logger', () => ({ logWarn: mock.warn, logInfo: mock.info }))
import { startWatchdog, watchdogEvents } from '../src/main/watchdog'
let win: EventEmitter & { webContents: ReturnType<typeof contents> }
let watchdog: ReturnType<typeof startWatchdog>
const exhausted = vi.fn()
function contents() {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false, getOSProcessId: () => 123, send: vi.fn(), reload: vi.fn() })
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(0)
  win = Object.assign(new EventEmitter(), { webContents: contents(), isDestroyed: () => false })
  watchdog = startWatchdog(win as unknown as BrowserWindow, () => ({ sessions: 2, transfers: 4 }), exhausted)
})
afterEach(() => { watchdog.stop(); vi.useRealTimers() })
it('warns once after three missed responses, samples both processes and reports recovery duration', () => {
  vi.advanceTimersByTime(14999); expect(mock.warn).not.toHaveBeenCalled(); expect(mock.metrics).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1); expect(mock.warn).toHaveBeenCalledTimes(1)
  const message = mock.warn.mock.calls[0][0]
  expect(message).toContain('"sessions":2'); expect(message).toContain('"transfers":4')
  expect(message).toContain('"main":{"rss":'); expect(message).toContain('"renderer":{"pid":123,"memory":{"workingSetSize":456}}')
  vi.advanceTimersByTime(5000); expect(mock.warn).toHaveBeenCalledTimes(1)
  watchdog.pong(1); expect(mock.info).not.toHaveBeenCalled()
  watchdog.pong(win.webContents.send.mock.lastCall![1])
  expect(mock.info).toHaveBeenCalledWith('watchdog recovered durationMs=20000')
  vi.advanceTimersByTime(5000); expect(mock.warn).toHaveBeenCalledTimes(1)
})
it('does not warn for timely pongs or intermittent misses', () => {
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(10000); watchdog.pong(win.webContents.send.mock.lastCall![1])
  }
  expect(mock.warn).not.toHaveBeenCalled()
})
it('records native events, reloads at most three times and ignores clean exits', () => {
  win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
  expect(win.webContents.reload).not.toHaveBeenCalled()
  for (let n = 0; n < 5; n++) win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
  expect(win.webContents.reload).toHaveBeenCalledTimes(3); expect(exhausted).toHaveBeenCalledTimes(1)
  expect(mock.warn).toHaveBeenCalledWith('render-process-gone reason=crashed exitCode=9')
  win.webContents.emit('unresponsive'); win.webContents.emit('responsive')
  expect(mock.warn.mock.lastCall![0]).toContain('renderer unresponsive')
  expect(mock.info).toHaveBeenCalledWith('renderer responsive')
})
it('bounds event history and disposes timers and listeners with the window', () => {
  for (let i = 0; i < 70; i++) win.webContents.emit('responsive')
  expect(watchdogEvents()).toHaveLength(50)
  watchdogEvents().pop(); expect(watchdogEvents()).toHaveLength(50)
  win.emit('closed'); const calls = win.webContents.send.mock.calls.length
  vi.advanceTimersByTime(60000); expect(win.webContents.send).toHaveBeenCalledTimes(calls)
  expect(win.webContents.listenerCount('render-process-gone')).toBe(0)
})
it('survives a renderer with no live frame', () => {
  win.webContents.send.mockImplementation(() => { throw new Error('disposed') })
  expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
})
