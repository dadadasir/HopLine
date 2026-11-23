import { app } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJsonFile, writeJsonFile } from '../core/json-file'
import { NewerVersionError } from '../core/vault-migrate'
import type { Snippet, SnippetInput } from '../shared/types'
import { logError } from './logger'

const filePath = () => path.join(app.getPath('userData'), 'snippets.json')
const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function validate(input: SnippetInput): void {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 ||
      typeof input.command !== 'string' || !input.command.trim() || input.command.length > 4000 ||
      (input.hostId !== null && !validId(input.hostId)) || (input.id !== undefined && !validId(input.id))) {
    throw new Error('snippet.invalid')
  }
}

export function listSnippets(): Snippet[] {
  return readJsonFile(filePath(), (raw) => {
    const data = raw as { version: number; snippets: Snippet[] } | null
    if (data && typeof data.version === 'number' && data.version > 1) throw new NewerVersionError(filePath())
    if (data?.version !== 1 || !Array.isArray(data.snippets) || data.snippets.length > 500) throw new Error('snippet.invalid')
    const ids = new Set<string>()
    for (const snippet of data.snippets) {
      validate(snippet)
      if (!validId(snippet.id) || ids.has(snippet.id) || !Number.isFinite(snippet.createdAt) ||
          !Number.isFinite(snippet.updatedAt)) throw new Error('snippet.invalid')
      ids.add(snippet.id)
    }
    return data.snippets
  }, () => [], logError)
}

export function saveSnippet(input: SnippetInput): Snippet {
  validate(input)
  const snippets = listSnippets()
  const index = snippets.findIndex((snippet) => snippet.id === input.id)
  if (input.id !== undefined && index < 0) throw new Error('snippet.missing')
  if (index < 0 && snippets.length >= 500) throw new Error('snippet.limit')
  const now = Date.now()
  const saved: Snippet = { id: input.id ?? randomUUID(), name: input.name.trim(), command: input.command,
    hostId: input.hostId, createdAt: index < 0 ? now : snippets[index].createdAt, updatedAt: now }
  if (index < 0) snippets.push(saved)
  else snippets[index] = saved
  writeJsonFile(filePath(), { version: 1, snippets })
  return saved
}

export function deleteSnippet(id: string): void {
  if (!validId(id)) throw new Error('snippet.invalid')
  const snippets = listSnippets().filter((snippet) => snippet.id !== id)
  writeJsonFile(filePath(), { version: 1, snippets })
}
