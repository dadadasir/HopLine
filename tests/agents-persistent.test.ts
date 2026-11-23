import { expect, it } from 'vitest'
import { agentFromTitle } from '../src/renderer/src/logic/agents'
it.each([
  ['✳ thinking', 'Claude Code'], ['CLAUDE CODE', 'Claude Code'], ['codex running', 'Codex'],
  ['AIDER', 'Aider'], ['Gemini CLI', 'Gemini CLI'], ['vim claudette.txt', 'Claude Code'],
  ['bash — localhost', undefined], ['code.txt', undefined], ['', undefined]
])('recognizes %s as %s', (title, expected) => expect(agentFromTitle(title!)).toBe(expected))
