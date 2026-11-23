import type { IMarker, Terminal } from '@xterm/xterm'

interface CommandMark { a: IMarker; c?: IMarker; d?: IMarker; column?: number; endColumn?: number; code?: number }
export function oscDirectory(text: string, hostname: string): string | undefined {
  try {
    if (!/^file:\/\//i.test(text) || /[\x00-\x20\\]/.test(text)) return
    const url = new URL(text)
    if (url.protocol !== 'file:' || url.username || url.password || url.port || url.search || url.hash ||
      !['', 'localhost', hostname.toLowerCase()].includes(url.hostname.toLowerCase())) return
    const path = decodeURIComponent(url.pathname)
    if (path.startsWith('/') && !path.startsWith('//') && !path.includes('\0')) return path
  } catch { /* Ignore malformed remote URLs. */ }
}

export class ShellMarks {
  active = false
  cwd?: string
  commands: CommandMark[] = []
  private pending?: CommandMark
  private navigation?: number
  private readonly handlers: { dispose(): void }[]
  private readonly listeners = new Set<() => void>()
  constructor(private readonly term: Terminal, hostname: () => string) {
    this.handlers = [term.parser.registerOscHandler(7, (text) => {
      const cwd = oscDirectory(text, hostname())
      if (cwd !== undefined && cwd !== this.cwd) { this.cwd = cwd; this.changed() }
      return true
    }), term.parser.registerOscHandler(133, (text) => {
      if (term.buffer.active.type !== 'normal' || !/^(A|C|D(?:;[0-9]{1,3})?)$/.test(text)) return true
      this.active = true
      if (text === 'A') {
        if (this.pending && !this.pending.c) this.pending.a.dispose()
        if (this.commands.length >= 2000) this.commands[0].a.dispose()
        const a = term.registerMarker(0)
        if (a) {
          this.pending = { a }; this.commands.push(this.pending)
          const command = this.pending
          a.onDispose(() => { command.c?.dispose(); command.d?.dispose(); this.commands = this.commands.filter((item) => item.a !== a) })
        }
      } else if (text === 'C' && this.pending && !this.pending.c) {
        this.pending.c = term.registerMarker(0); this.pending.column = term.buffer.active.cursorX
      } else if (text.startsWith('D') && this.pending?.c && !this.pending.d) {
        this.pending.d = term.registerMarker(0); this.pending.endColumn = term.buffer.active.cursorX
        this.pending.code = Number(text.split(';')[1] ?? 0)
        if (this.pending.code !== 0) {
          const decoration = term.registerDecoration({ marker: this.pending.a, x: 0, width: 1, backgroundColor: '#ef4444', layer: 'top' })
          decoration?.onRender((element) => { element.style.width = '3px'; element.style.marginLeft = '-4px' })
        }
      }
      this.navigation = undefined; this.changed(); return true
    })]
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(): void { for (const listener of this.listeners) listener() }
  jump(direction: -1 | 1): boolean {
    if (!this.active) return false
    const buffer = this.term.buffer.active
    const from = this.navigation ?? (buffer.viewportY === buffer.baseY ? buffer.baseY + buffer.cursorY + 1 : buffer.viewportY)
    const lines = this.commands.filter((item) => item.c).map((item) => item.a.line).filter((line) => line >= 0)
    const line = direction < 0 ? lines.filter((line) => line < from).at(-1) : lines.find((line) => line > from)
    if (line !== undefined) { this.navigation = line; this.term.scrollToLine(line) }
    return true
  }
  output(): string | undefined {
    const command = this.commands.filter((item) => item.c && item.d && !item.c.isDisposed && !item.d.isDisposed).at(-1)
    if (!command?.c || !command.d) return
    let text = ''
    for (let row = command.c.line; row <= command.d.line; row++) {
      const line = this.term.buffer.normal.getLine(row)
      if (row > command.c.line && !line?.isWrapped) text += '\n'
      text += line?.translateToString(true, row === command.c.line ? command.column : 0, row === command.d.line ? command.endColumn : undefined) ?? ''
    }
    return text.replace(/\n$/, '')
  }
  dispose(): void {
    this.handlers.forEach((handler) => handler.dispose())
    for (const item of [...this.commands]) { item.a.dispose(); item.c?.dispose(); item.d?.dispose() }
    this.listeners.clear()
  }
}

export const shellMarks = new Map<string, ShellMarks>()
const listeners = new Set<() => void>()
export const subscribeShellMarks = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const notifyShellMarks = (): void => { for (const listener of listeners) listener() }
