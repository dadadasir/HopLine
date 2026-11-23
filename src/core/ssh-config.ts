import path from 'node:path'
import type { HostPublic, ImportCandidate, JumpInput, SshConfigPreview } from '../shared/types'
import { isWindowsNamedPipe, isWindowsPath, normalizeWindowsPipe } from './win-platform'

// A reader alone cannot enumerate a directory; glob is injected alongside it.
export type SshConfigReader = ((path: string) => string | null) & { glob?: (pattern: string) => string[] }
const concrete = (name: string) => !/[*?!]/.test(name)
const pattern = (value: string) => new RegExp(`^${value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')

function words(line: string): string[] {
  const result: string[] = []
  let word = '', quote = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    const next = line[i + 1]
    if (char === '\\' && next !== undefined) {
      if (next === '\\' || (quote ? next === quote : (/[\s"'#]/.test(next)))) {
        word += next
        i++
        continue
      }
    }
    if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#') break
    else if (/\s/.test(char)) { if (word) result.push(word); word = '' }
    else word += char
  }
  if (word) result.push(word)
  return result
}

export function parseSshConfig(entry: string, readFile: SshConfigReader, home: string): SshConfigPreview {
  const warnings = new Set<string>(), aliases = new Set<string>()
  const winHome = isWindowsPath(home)
  const paths = winHome ? path.win32 : path
  const expand = (value: string) => {
    const replaced = value.replace(/%d/g, home).replace(/%USERPROFILE%/gi, home)
    if (replaced === '~') return home
    if (replaced.startsWith('~/') || replaced.startsWith('~\\')) return paths.join(home, replaced.slice(2))
    if (isWindowsNamedPipe(replaced)) return winHome ? normalizeWindowsPipe(replaced) : replaced
    return replaced
  }
  const absolute = (value: string) => {
    const expanded = expand(value)
    if (isWindowsNamedPipe(expanded) || expanded.toLowerCase() === 'pageant') return expanded
    return paths.resolve(home, '.ssh', expanded)
  }
  const contents = new Map<string, string | null>()
  const read = (file: string) => {
    if (!contents.has(file)) contents.set(file, readFile(file))
    return contents.get(file)!
  }
  function values(alias: string | null, notes: Set<string>): Record<string, string> {
    const fields: Record<string, string> = {}
    let active = true, match = false
    function visit(file: string, stack: string[]) {
      if (stack.includes(file)) { notes.add(`Include 循环：${file}`); return }
      if (stack.length > 16) { notes.add(`Include 超过 16 层：${file}`); return }
      const source = read(file)
      if (source === null) return
      for (const line of source.split(/\r?\n/)) {
        const tokens = words(line.replace(/^(\s*[^\s=]+)\s*=\s*/, '$1 '))
        const key = tokens.shift()?.toLowerCase()
        if (!key || !tokens.length) continue
        if (key === 'host') {
          match = false
          if (alias === null) tokens.filter(concrete).forEach((name) => aliases.add(name))
          active = alias === null || (tokens.some((name) => !name.startsWith('!') && pattern(name).test(alias)) &&
            !tokens.some((name) => name.startsWith('!') && pattern(name.slice(1)).test(alias)))
        } else if (key === 'match') {
          match = true
          notes.add(`Match 块不受支持，已跳过：${tokens.join(' ')}`)
        } else if (key === 'include' && !match && active) {
          for (const token of tokens) {
            const target = absolute(token)
            if (/[*?[]/.test(target) && !readFile.glob) notes.add(`Include 通配符需要 glob：${target}`)
            const files = /[*?[]/.test(target) ? readFile.glob?.(target) ?? [] : [target]
            for (const next of [...files].sort()) visit(paths.resolve(next), [...stack, file])
          }
        } else if (active && !match && fields[key] === undefined) fields[key] = tokens.join(' ')
      }
    }
    visit(absolute(entry), [])
    return fields
  }
  values(null, warnings)
  const resolve = (alias: string, stack: string[], notes: Set<string>): ImportCandidate => {
    if (stack.includes(alias)) throw new Error(`ProxyJump 循环：${[...stack, alias].join(' → ')}`)
    const fields = values(alias, notes)
    const file = fields.identityfile && fields.identityfile !== 'none' ? expand(fields.identityfile) : null
    const socket = fields.identityagent ? expand(fields.identityagent) : null
    for (const value of [file, socket]) if (value?.includes('%')) notes.add(`${alias}：未展开的占位符：${value}`)
    const pub = file ? (file.endsWith('.pub') ? file : `${file}.pub`) : null
    const identityFile = pub && read(pub) !== null ? pub : null
    const privateKey = file && !file.endsWith('.pub') && read(file) !== null
    const authType = !socket && privateKey ? 'privateKey' : 'agent'
    if (file && !identityFile && authType === 'agent') notes.add(`${alias}：公钥不存在，无法限制 agent 钥匙：${pub}`)
    if (fields.identitiesonly?.toLowerCase() === 'yes' && !identityFile && authType === 'agent') notes.add(`${alias}：IdentitiesOnly 无可用公钥`)
    const port = Number(fields.port ?? 22)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${alias}：Port 无效`)
    const result: ImportCandidate = {
      groupId: null, name: alias, host: fields.hostname || alias, port, username: fields.user ?? '', authType,
      privateKeyPath: authType === 'privateKey' ? file : null,
      agent: authType === 'agent' ? { socket, identityFile, forward: fields.forwardagent?.toLowerCase() === 'yes' } : null,
      jumps: [], jumpNames: [], warnings: [], duplicateOf: null
    }
    if (fields.proxycommand) notes.add(`${alias}：ProxyCommand 不受支持，已忽略`)
    else if (fields.proxyjump && fields.proxyjump.toLowerCase() !== 'none') {
      for (const target of fields.proxyjump.split(',')) {
        const parts = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(target.trim())
        if (!parts) throw new Error(`${alias}：ProxyJump 无效：${target}`)
        const [, user, address, portText] = parts
        const name = address.replace(/^\[|\]$/g, '')
        const found = [...aliases].find((item) => item.toLowerCase() === name.toLowerCase())
        const hop = resolve(found ?? name, [...stack, alias], notes)
        if (user) hop.username = user
        if (portText) hop.port = Number(portText)
        if (hop.port < 1 || hop.port > 65535) throw new Error(`${alias}：ProxyJump Port 无效`)
        const nested = [...hop.jumps, hop as JumpInput]
        const names = [...hop.jumpNames, target.trim()]
        // Shared recursive prefixes (a,b where b itself uses a) are traversed once.
        let shared = 0
        while (shared < result.jumps.length && shared < hop.jumps.length &&
          JSON.stringify(result.jumps[shared]) === JSON.stringify(hop.jumps[shared])) shared++
        for (let index = shared; index < nested.length; index++) {
          const { host, port, username, authType, privateKeyPath, agent } = nested[index]
          result.jumps.push({ host, port, username, authType, privateKeyPath, agent: agent ? { ...agent, forward: false } : null })
          result.jumpNames.push(names[index])
        }
      }
    }
    if (result.jumps.length > 5) throw new Error(`${alias}：跳板最多 5 级`)
    return result
  }
  const hosts: ImportCandidate[] = []
  for (const alias of aliases) {
    const notes = new Set<string>()
    try {
      const host = resolve(alias, [], notes)
      host.warnings = [...notes]
      hosts.push(host)
    } catch (error) { notes.add(error instanceof Error ? error.message : String(error)) }
    notes.forEach((note) => warnings.add(note))
  }
  return { hosts, warnings: [...warnings] }
}

export function markSshConfigDuplicates(preview: SshConfigPreview, existing: Pick<HostPublic, 'id' | 'host' | 'port' | 'username'>[]): SshConfigPreview {
  return { ...preview, hosts: preview.hosts.map((candidate) => ({ ...candidate,
    duplicateOf: existing.find((host) => host.host === candidate.host && host.port === candidate.port && host.username === candidate.username)?.id ?? null
  })) }
}
