import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'

const terms = new Map<string, Terminal>()
const searches = new Map<string, SearchAddon>()
const buffers = new Map<string, (string | Uint8Array)[]>()

export function attachTerminal(id: string, term: Terminal, search: SearchAddon): void {
  terms.set(id, term)
  searches.set(id, search)
  const pending = buffers.get(id)
  if (pending) {
    for (const chunk of pending) term.write(chunk)
    buffers.delete(id)
  }
}

export function detachTerminal(id: string): void {
  terms.get(id)?.dispose()
  terms.delete(id)
  searches.delete(id)
  buffers.delete(id)
}

export function writeTerminal(id: string, data: string | Uint8Array): void {
  const term = terms.get(id)
  if (!term) {
    const queue = buffers.get(id) ?? []
    queue.push(data)
    if (queue.length > 400) queue.shift()
    buffers.set(id, queue)
    return
  }
  term.write(data)
}

export function searchOf(id: string | null): SearchAddon | undefined {
  if (!id) return undefined
  return searches.get(id)
}

export function terminalOf(id: string | null): Terminal | undefined {
  if (!id) return undefined
  return terms.get(id)
}

export function eachTerminal(visit: (term: Terminal) => void): void {
  for (const term of terms.values()) visit(term)
}
