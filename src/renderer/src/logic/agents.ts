export const agents = [
  { name: 'Claude Code', pattern: /^(?:✳)|claude/i },
  { name: 'Codex', pattern: /codex/i },
  { name: 'Aider', pattern: /aider/i },
  { name: 'Gemini CLI', pattern: /gemini/i }
]
export function agentFromTitle(title: string): string | undefined {
  return agents.find((agent) => agent.pattern.test(title))?.name
}
