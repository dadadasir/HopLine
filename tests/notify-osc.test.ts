import { afterEach, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { installOscPolicy } from '../src/renderer/src/terminal/osc'
import { cleanNotificationText } from '../src/renderer/src/logic/notify'

afterEach(() => vi.restoreAllMocks())

it('routes real xterm OSC 9, OSC 777 and background BEL through one limiter, preserves session and strips controls', async () => {
  const term = new Terminal({ allowProposedApi: true }), onNotify = vi.fn(), openExternal = vi.fn()
  let now = 0, background = true
  const dispose = installOscPolicy(term, { sessionId: 'tab', title: () => 'Tab', onNotify, openExternal,
    now: () => now, isBackground: () => background })
  const write = (text: string) => new Promise<void>((resolve) => term.write(text, resolve))
  try {
    await write('\x1b]9;done\x07')
    expect(onNotify).toHaveBeenLastCalledWith('tab', { title: 'Tab', body: 'done' })
    await write('\x1b]777;notify;T;B\x07\x07')
    expect(onNotify).toHaveBeenCalledTimes(1)
    now += 10_000
    await write(`\x1b]777;notify;${'t'.repeat(70)};a\t${'文'.repeat(270)}\x07`)
    expect(onNotify).toHaveBeenLastCalledWith('tab', { title: 't'.repeat(64), body: 'a' + '文'.repeat(255) })
    now += 10_000
    await write('\x07')
    expect(onNotify).toHaveBeenLastCalledWith('tab', { title: 'Tab', body: '' })
    background = false; now += 10_000
    await write('\x07')
    expect(onNotify).toHaveBeenCalledTimes(3)
    await write('\x1b]9;https://example.com;$(touch /tmp/never)\x07')
    expect(openExternal).not.toHaveBeenCalled()
    expect(onNotify.mock.calls[3][1].body).toContain('$(touch')
  } finally { dispose(); term.dispose() }
})

it('handles all progress states without consuming notification quota; titles do not rename tabs; OSC 52 stays swallowed', async () => {
  const term = new Terminal({ allowProposedApi: true }), onProgress = vi.fn(), onTitle = vi.fn(), onNotify = vi.fn(), fallback = vi.fn(() => true)
  term.parser.registerOscHandler(52, fallback)
  const dispose = installOscPolicy(term, { openExternal: vi.fn(), onProgress, onTitle, onNotify, now: () => 500 })
  const write = (text: string) => new Promise<void>((resolve) => term.write(text, resolve))
  try {
    for (const state of [0, 1, 2, 3, 4]) await write(`\x1b]9;4;${state};70\x07`)
    expect(onProgress.mock.calls.map(([value]) => value)).toEqual([null, ...[1, 2, 3, 4].map((state) => ({ state, value: 70, updatedAt: 500 }))])
    await write('\x1b]9;4;9;10\x07\x1b]9;done\x07')
    expect(onProgress).toHaveBeenCalledTimes(5)
    expect(onNotify).toHaveBeenCalledOnce()
    await write('\x1b]0;✳ Claude\x07\x1b]2;Codex\x1b\\')
    expect(onTitle.mock.calls).toEqual([['✳ Claude'], ['Codex']])
    await write('\x1b]52;c;?\x07\x1b]52;c;aGk=\x07')
    expect(fallback).not.toHaveBeenCalled()
  } finally { dispose(); term.dispose() }
})

it('strips all C0/C1 controls and truncates by Unicode code point', () => {
  expect(cleanNotificationText('\0\t\r\n\x1b\x7f\x80\x9fHi', 64)).toBe('Hi')
  expect(cleanNotificationText('😀'.repeat(70), 64)).toBe('😀'.repeat(64))
})
