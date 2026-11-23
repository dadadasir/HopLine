import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import type { IBufferRange } from '@xterm/xterm'
import { installOscPolicy, NotificationLimiter } from '../src/renderer/src/terminal/osc'

afterEach(() => vi.restoreAllMocks())

describe('notification limiter', () => {
  it('admits one event per ten seconds without extending the window for dropped events', () => {
    const limiter = new NotificationLimiter()
    expect([0, 1, 9999, 10000, 10001, 19999, 20000].map((now) => limiter.accept(now)))
      .toEqual([true, false, false, true, false, false, true])
  })

  it('keeps separate sessions independent', () => {
    const a = new NotificationLimiter()
    const b = new NotificationLimiter()
    expect(a.accept(42)).toBe(true)
    expect(a.accept(43)).toBe(false)
    expect(b.accept(43)).toBe(true)
  })
})

describe('OSC policy', () => {
  it('swallows clipboard reads and writes, shares notification throttling with BEL, and disposes handlers', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const fallback = vi.fn(() => true)
    for (const code of [52, 9, 777]) term.parser.registerOscHandler(code, fallback)
    const accept = vi.spyOn(NotificationLimiter.prototype, 'accept')
    const openExternal = vi.fn().mockResolvedValue(undefined)
    let now = 0
    const dispose = installOscPolicy(term, { openExternal, now: () => now })
    const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve))
    try {
      await write('\x1b]52;c;aGk=\x07\x1b]52;c;?\x1b\\')
      expect(fallback).not.toHaveBeenCalled()
      expect(accept).not.toHaveBeenCalled()
      await write('\x1b]9;hello\x07\x1b]777;notify;title;body\x1b\\\x07')
      now = 10_000
      await write('\x07')
      expect(accept.mock.results.map((result) => result.value)).toEqual([true, false, false, true])
      expect(openExternal).not.toHaveBeenCalled()
      expect(fallback).not.toHaveBeenCalled()
      dispose()
      await write('\x1b]52;c;aGk=\x07\x1b]9;hello\x07\x1b]777;notify;title;body\x07\x07')
      expect(fallback).toHaveBeenCalledTimes(3)
      expect(accept).toHaveBeenCalledTimes(4)
    } finally {
      term.dispose()
    }
  })

  it.each([
    ['https://example.com/path', true], ['http://example.com', true], ['HTTPS://example.com', true],
    ['file:///etc/passwd', false], ['javascript:alert(1)', false], ['hopline:open', false],
    ['data:text/plain,hi', false], ['mailto:test@example.com', false], ['//example.com', false], ['broken', false]
  ])('opens %s only on activation and only if HTTP(S)', (uri, allowed) => {
    const term = new Terminal({ allowProposedApi: true })
    const previous = { activate: vi.fn() }
    term.options.linkHandler = previous
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const dispose = installOscPolicy(term, { openExternal })
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent
    const range: IBufferRange = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }
    try {
      expect(openExternal).not.toHaveBeenCalled()
      term.options.linkHandler?.hover?.(event, uri, range)
      expect(openExternal).not.toHaveBeenCalled()
      term.options.linkHandler!.activate(event, uri, range)
      expect(openExternal).toHaveBeenCalledTimes(allowed ? 1 : 0)
      if (allowed) expect(openExternal).toHaveBeenCalledWith(uri)
      expect(previous.activate).not.toHaveBeenCalled()
      expect(event.preventDefault).toHaveBeenCalledOnce()
      dispose()
      expect(term.options.linkHandler).toBe(previous)
    } finally {
      term.dispose()
    }
  })

  it('does not leak rejected external-open promises', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const openExternal = vi.fn().mockRejectedValue(new Error('shell unavailable'))
    const dispose = installOscPolicy(term, { openExternal })
    try {
      term.options.linkHandler!.activate({ preventDefault() {} } as MouseEvent, 'https://example.com', {} as IBufferRange)
      await Promise.resolve()
      expect(openExternal).toHaveBeenCalledOnce()
    } finally {
      dispose()
      term.dispose()
    }
  })
})
