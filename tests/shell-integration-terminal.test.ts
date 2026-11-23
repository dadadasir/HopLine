import { expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { ShellMarks, oscDirectory } from '../src/renderer/src/terminal/marks'
import { shellOutputActions } from '../src/renderer/src/logic/palette'

const osc = (value: string) => `\x1b]${value}\x07`
const write = (term: Terminal, value: string) => new Promise<void>((resolve) => term.write(value, resolve))
it.each([
  ['file:///tmp/a%20b%23%25%E4%B8%AD', '/tmp/a b#%中'], ['file://localhost/tmp', '/tmp'],
  ['file://MY-HOST/tmp', '/tmp'], ['file://other/tmp', undefined], ['https://my-host/tmp', undefined],
  ['file://user@my-host/tmp', undefined], ['file://my-host:22/tmp', undefined], ['file://my-host/tmp?x', undefined],
  ['file://my-host/tmp#x', undefined], ['file://my-host/%00', undefined], ['file://my-host/%FF', undefined],
  ['file://my-host/%', undefined], ['file://my-host//other/path', undefined], ['file://my-host/a\\b', undefined],
  ['file://my-host/raw space', undefined], ['file:////other/path', undefined], ['file://my-host/%0A', '/\n']
])('validates and decodes OSC 7 %s', (input, expected) => { expect(oscDirectory(input, 'my-host')).toBe(expected) })
it('real xterm: tracks A/C/D markers, exact output, exit status, decorations and navigation', async () => {
  const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 3, scrollback: 20 })
  const marks = new ShellMarks(term, () => 'my-host'), decoration = vi.spyOn(term, 'registerDecoration'), scroll = vi.spyOn(term, 'scrollToLine')
  try {
    expect(marks.active).toBe(false); expect(marks.jump(-1)).toBe(false)
    expect(shellOutputActions(marks.active, 'copy', vi.fn())).toEqual([])
    await write(term, osc('7;file://my-host/a%20b') + osc('133;bogus'))
    expect(marks.cwd).toBe('/a b'); expect(marks.active).toBe(false)
    await write(term, osc('7;file://other/no') + osc('133;D;1') + osc('133;A') + '$ false\r\n' + osc('133;C') + 'failed\r\n' + osc('133;D;1') + osc('133;A') + '$ ')
    expect(marks.cwd).toBe('/a b'); expect(marks.active).toBe(true)
    expect(marks.commands[0]).toMatchObject({ code: 1, a: { line: 0 }, c: { line: 1 }, d: { line: 2 } })
    expect(marks.output()).toBe('failed')
    expect(decoration).toHaveBeenCalledWith(expect.objectContaining({ marker: marks.commands[0].a, backgroundColor: '#ef4444' }))
    await write(term, 'echo ok\r\n' + osc('133;C') + 'ok\r\n' + osc('133;D;0') + osc('133;A') + '$ ')
    expect(marks.output()).toBe('ok'); expect(marks.commands[1].code).toBe(0)
    expect(decoration).toHaveBeenCalledTimes(1)
    expect(shellOutputActions(marks.active, 'copy', vi.fn())).toHaveLength(1)
    marks.jump(-1); expect(scroll).toHaveBeenLastCalledWith(2)
    marks.jump(-1); expect(scroll).toHaveBeenLastCalledWith(0)
    marks.jump(1); expect(scroll).toHaveBeenLastCalledWith(2)
    const marker = marks.commands[0].a; marks.dispose(); expect(marker.isDisposed).toBe(true)
  } finally { marks.dispose(); term.dispose() }
})
it('joins wrapped lines, handles partial output columns and ignores duplicate completion', async () => {
  const term = new Terminal({ allowProposedApi: true, cols: 8, rows: 4 })
  const marks = new ShellMarks(term, () => '')
  try {
    await write(term, osc('133;A') + '$ ' + osc('133;C') + '123456789' + osc('133;D;0') + osc('133;D;2'))
    expect(marks.output()).toBe('123456789'); expect(marks.commands[0].code).toBe(0)
  } finally { marks.dispose(); term.dispose() }
})
it('scrollback eviction releases command markers and ignores alternate-buffer command boundaries', async () => {
  const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 2, scrollback: 2 }), marks = new ShellMarks(term, () => '')
  try {
    await write(term, '\x1b[?1049h' + osc('133;A') + '\x1b[?1049l')
    expect(marks.active).toBe(false)
    await write(term, osc('133;A') + '$\r\n' + osc('133;C') + 'out\r\n' + osc('133;D;1'))
    const { a, c, d } = marks.commands[0]
    await write(term, '\r\n'.repeat(15))
    expect(a.isDisposed).toBe(true); expect(c!.isDisposed).toBe(true); expect(d!.isDisposed).toBe(true)
    expect(marks.commands).toHaveLength(0); expect(marks.output()).toBeUndefined()
  } finally { marks.dispose(); term.dispose() }
})
