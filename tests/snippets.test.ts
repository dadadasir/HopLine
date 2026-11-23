import { describe, expect, it, vi } from 'vitest'
import type { Snippet } from '../src/shared/types'
import { extractVariables, fillVariables, matchSnippets, pasteSnippet } from '../src/renderer/src/logic/snippet'
import { paletteItems } from '../src/renderer/src/logic/palette'

describe('snippet variables', () => {
  it('deduplicates variables in first appearance order', () => {
    expect(extractVariables('{{second}} {{first}} {{second}} {{_x-2}}')).toEqual(['second', 'first', '_x-2'])
  })

  it('treats four opening braces as an escape in both extraction and filling', () => {
    const command = '{{{{literal}} {{{{{{value}} {{{{{{{{ {{value}}'
    expect(extractVariables(command)).toEqual(['value'])
    expect(fillVariables(command, { value: 'ok' })).toBe('{{literal}} {{ok {{{{ ok')
  })

  it('ignores invalid names and accepts the 32-character boundary', () => {
    const name = 'a'.repeat(32)
    const invalid = '{{}} {{1a}} {{a.b}} {{ a}} {{a b}} {{中文}} {{' + name + 'a}}'
    expect(extractVariables(`${invalid} {{${name}}}`)).toEqual([name])
    expect(fillVariables(invalid, {})).toBe(invalid)
  })

  it('rejects missing values, including inherited properties, but accepts empty strings', () => {
    expect(() => fillVariables('{{value}}', {})).toThrow('Missing variable: value')
    expect(() => fillVariables('{{toString}}', {})).toThrow('Missing variable: toString')
    expect(fillVariables('{{value}}', { value: '' })).toBe('')
    expect(fillVariables('{{__proto__}}', JSON.parse('{"__proto__":"literal"}'))).toBe('literal')
  })

  it('substitutes once without interpreting replacement syntax or nested placeholders', () => {
    expect(fillVariables('{{a}} {{a}} {{b}}', { a: '$& {{b}}', b: 'done' })).toBe('$& {{b}} $& {{b}} done')
  })
})

describe('snippet matching and palette integration', () => {
  const snippets: Snippet[] = [
    { id: 'global', name: 'Docker logs', command: 'docker logs app', hostId: null, createdAt: 1, updatedAt: 1 },
    { id: 'other', name: 'Docker elsewhere', command: 'docker ps', hostId: 'other', createdAt: 1, updatedAt: 1 },
    { id: 'host', name: 'Docker production', command: 'docker logs service', hostId: 'host', createdAt: 1, updatedAt: 1 },
    { id: 'global2', name: 'List files', command: 'ls -lah', hostId: null, createdAt: 1, updatedAt: 1 },
    { id: 'host2', name: 'List logs', command: 'tail app.log', hostId: 'host', createdAt: 1, updatedAt: 1 }
  ]

  it('only shows global snippets locally and puts current-host snippets first stably', () => {
    expect(matchSnippets(snippets, '', null).map((s) => s.id)).toEqual(['global', 'global2'])
    expect(matchSnippets(snippets, '', 'host').map((s) => s.id)).toEqual(['host', 'host2', 'global', 'global2'])
    expect(snippets.map((s) => s.id)).toEqual(['global', 'other', 'host', 'global2', 'host2'])
  })

  it('matches case-insensitive subsequences in names and commands and trims the query', () => {
    expect(matchSnippets(snippets, '  DKR  ', 'host').map((s) => s.id)).toEqual(['host', 'global'])
    expect(matchSnippets(snippets, 'LS -L', null).map((s) => s.id)).toEqual(['global2'])
    expect(matchSnippets(snippets, 'no match', 'host')).toEqual([])
  })

  it('keeps fuzzy matches through the command palette filter and runs the selected action', () => {
    const run = vi.fn()
    const actions = matchSnippets(snippets, '', 'host').map((s) => ({
      id: `snippet:${s.id}`, label: s.name, run,
      matches: (query: string) => matchSnippets([s], query, 'host').length > 0
    }))
    const items = paletteItems([], actions, 'DKR')
    expect(items.map((s) => s.id)).toEqual(['action:snippet:host', 'action:snippet:global'])
    if (items[0].kind === 'action') items[0].action.run()
    expect(run).toHaveBeenCalledOnce()
  })
})

describe('snippet terminal insertion', () => {
  it.each(['echo hello', 'echo one\necho two', 'echo one\r\necho two', 'echo trailing\n'])('pastes the exact command without appending Enter: %j', (command) => {
    const term = { paste: vi.fn(), write: vi.fn() }
    pasteSnippet(term, command)
    expect(term.paste).toHaveBeenCalledExactlyOnceWith(command)
    expect(term.write).not.toHaveBeenCalled()
  })

  it('fills and unescapes before paste, leaving bracketed-paste handling to xterm', () => {
    const term = { paste: vi.fn() }
    pasteSnippet(term, 'echo {{name}}\necho {{{{literal}}', { name: 'hello' })
    expect(term.paste).toHaveBeenCalledExactlyOnceWith('echo hello\necho {{literal}}')
    expect(() => pasteSnippet(term, '{{missing}}')).toThrow()
    expect(term.paste).toHaveBeenCalledTimes(1)
  })
})
