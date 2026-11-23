import type { Snippet } from '../../../shared/types'

const tokens = /\{\{\{\{|\{\{([A-Za-z_][A-Za-z0-9_-]{0,31})\}\}/g

export function extractVariables(command: string): string[] {
  return [...new Set([...command.matchAll(tokens)].flatMap((match) => match[1] ? [match[1]] : []))]
}

export function fillVariables(command: string, values: Record<string, string>): string {
  return command.replace(tokens, (_, name: string | undefined) => {
    if (!name) return '{{'
    if (!Object.hasOwn(values, name) || typeof values[name] !== 'string') throw new Error(`Missing variable: ${name}`)
    return values[name]
  })
}

export function matchSnippets(snippets: readonly Snippet[], query: string, hostId: string | null): Snippet[] {
  const q = query.trim().toLowerCase()
  return snippets.filter((snippet) => {
    if (snippet.hostId !== null && snippet.hostId !== hostId) return false
    const text = `${snippet.name} ${snippet.command}`.toLowerCase()
    let index = 0
    for (const char of q) {
      index = text.indexOf(char, index)
      if (index < 0) return false
      index += char.length
    }
    return true
  }).sort((a, b) => Number(b.hostId !== null) - Number(a.hostId !== null))
}

export function pasteSnippet(term: { paste: (text: string) => void }, command: string, values: Record<string, string> = {}): void {
  term.paste(fillVariables(command, values))
}
