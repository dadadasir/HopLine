export interface RecognizedConnection { host: string; port: number | null; username?: string; password?: string }
const usernamePattern = /^[\w.-]+$/
function portNumber(value: string): number | null {
  const port = /^\d+$/.test(value) ? Number(value) : 0
  return port >= 1 && port <= 65535 ? port : null
}
function ipv4(value: string): boolean { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(part => Number(part) <= 255) }
function ipv6Key(value: string): string | null {
  if (!value.includes(':')) return null
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1) } catch { return null }
}
function addressKey(value: string): string {
  const key = ipv6Key(value)
  if (key?.startsWith('::ffff:')) {
    const parts = key.slice(7).split(':')
    if (parts.length === 2) {
      const hi = parseInt(parts[0]!, 16), lo = parseInt(parts[1]!, 16)
      return [hi >>> 8, hi & 255, lo >>> 8, lo & 255].join('.')
    }
  }
  return key ?? value.toLowerCase()
}
function validHost(value: string): boolean {
  return ipv4(value) || ipv6Key(value) !== null || /^(?!-)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(value) && !/^\d+(?:\.\d+)+$/.test(value)
}
/** Parse data only: no shell expansion, commands, paths or unsupported SSH options. */
export function parseSshAddress(raw: string): RecognizedConnection | null {
  let text = raw.trim(), port = 22, optionUser: string | undefined
  if (!text || /[\r\n]/.test(text)) return null
  if (/^ssh\s/.test(text)) {
    const args = text.slice(3).trim().match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+/g) ?? []
    const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2')
    let target: string | undefined
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!
      if (arg === '-p' || /^-p\d+$/.test(arg)) {
        const value = portNumber(arg === '-p' ? args[++index] ?? '' : arg.slice(2))
        if (value === null) return null
        port = value
      } else if (arg === '-l' || /^-l.+/.test(arg)) {
        optionUser = unquote(arg === '-l' ? args[++index] ?? '' : arg.slice(2))
        if (!usernamePattern.test(optionUser)) return null
      } else if (arg === '-i' || /^-i.+/.test(arg)) {
        if (arg === '-i' && !args[++index]) return null
      } else if (!arg.startsWith('-') && !target) target = unquote(arg)
      else return null
    }
    if (!target) return null
    text = target
  } else if (/\s/.test(text)) return null
  const at = text.lastIndexOf('@'), username = at < 0 ? optionUser : text.slice(0, at)
  if (username !== undefined && (!usernamePattern.test(username) || username.startsWith('-'))) return null
  let host = at < 0 ? text : text.slice(at + 1)
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(host)
  if (bracket) { host = bracket[1]!; if (bracket[2]) { const parsed = portNumber(bracket[2]); if (!parsed) return null; port = parsed } }
  else if (host.split(':').length === 2) {
    const [address, rawPort] = host.split(':'); const parsed = portNumber(rawPort!)
    if (!parsed) return null
    host = address!; port = parsed
  }
  return validHost(host) ? { host, port, ...(username ? { username } : {}) } : null
}

const contextLabels = /(?:\b(?:gateway|dns|netmask)\b|网关|掩码|\b(?:ipv?[46]?|server|host)(?:\s+address)?\b|地址|服务器)/gi
function addressContext(prefix: string): 'exclude' | 'preferred' | 'other' {
  const labels = [...prefix.matchAll(contextLabels)]
  const last = labels.at(-1)?.[0]
  return !last ? 'other' : /gateway|dns|netmask|网关|掩码/i.test(last) ? 'exclude' : 'preferred'
}
function usefulAddress(host: string): boolean {
  const key = addressKey(host)
  return !/^(?:255|127)\./.test(key) && !['0.0.0.0', '::', '::1', 'localhost'].includes(key)
}
function plausibleIpv6(host: string): boolean {
  if (!ipv6Key(host)) return false
  return host.split(':').filter(Boolean).length >= 3 || /^[\d:]+$/.test(host) || /^(?:2[\da-f]{3}:|fe80:|f[cd][\da-f]{2}:|::ffff:)/i.test(host)
}

/** Per-line context keeps infrastructure/version text out of the candidate list. */
export function recognizeHostText(text: string): RecognizedConnection[] {
  if (text.length > 100_000) throw new Error('文本过长 / Text is too long')
  const label = (pattern: string) => new RegExp(`^\\s*(?:${pattern})\\s*[:：=]\\s*([^\\r\\n]*)`, 'im').exec(text)?.[1]?.trim()
  const rawUser = label('用户名|用户|登录用户|username|user|login(?: user(?:name)?)?')
  const username = rawUser && usernamePattern.test(rawUser) ? rawUser : undefined
  const password = label('密码|登录密码|初始密码|password|(?:root|initial|login) password')
  const rawPort = label('端口|SSH端口|SSH 端口|(?:ssh )?port')
  const port = rawPort === undefined ? 22 : portNumber(/^\d+/.exec(rawPort)?.[0] ?? '')
  const candidates: { host: string; port?: number | null; priority: number; order: number }[] = []
  const commands = new Map<string, RecognizedConnection>()
  let order = 0
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:密码|登录密码|初始密码|password|(?:root|initial|login) password|用户名|username|user)\s*[:：=]/i.test(line)) continue
    const urls = [...line.matchAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi)].map(match => ({ start: match.index!, end: match.index! + match[0].length }))
    const add = (host: string, index: number, endpointPort?: number | null) => {
      if (urls.some(url => index >= url.start && index < url.end)) return false
      const prefix = line.slice(0, index), context = addressContext(prefix)
      if (context === 'exclude' || !usefulAddress(host)) return false
      if (ipv4(host) && (/(?:\bkernel|\bversion|内核|版本|\bv)[\s:=_-]*$/i.test(prefix) ||
          context !== 'preferred' && /kernel|version|内核|版本|\bv\d/i.test(line) && Number(host.split('.')[0]) <= 9)) return false
      candidates.push({ host, port: endpointPort, priority: context === 'preferred' ? 0 : 1, order: order++ })
      return true
    }
    for (const match of line.matchAll(/\bssh\s+/g)) {
      const command = parseSshAddress(line.slice(match.index!))
      if (command && add(command.host, match.index!)) commands.set(addressKey(command.host), command)
    }
    for (const match of line.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)/g)) {
      if (!ipv4(match[0])) continue
      // The embedded IPv4 in a mapped IPv6 is handled as that entire address.
      if (match.index! > 0 && line[match.index! - 1] === ':') {
        const preceding = line.slice(0, match.index!)
        if (/::ffff:$/i.test(preceding)) continue
      }
      const suffix = line.slice(match.index! + match[0].length), endpoint = /^:(\d+)/.exec(suffix)
      add(match[0], match.index!, endpoint ? portNumber(endpoint[1]!) : undefined)
    }
    for (const match of line.matchAll(/(?<![\p{L}\p{N}_.])[\da-f]*:[\da-f:.]+/giu)) {
      const host = match[0].replace(/[.,]+$/, '')
      if (!plausibleIpv6(host)) continue
      const suffix = line.slice(match.index! + host.length), endpoint = /^\]:(\d+)/.exec(suffix)
      add(host, match.index!, endpoint ? portNumber(endpoint[1]!) : undefined)
    }
  }
  const unique = new Map<string, typeof candidates[number]>()
  for (const candidate of candidates.sort((a, b) => a.priority - b.priority || a.order - b.order)) {
    const key = addressKey(candidate.host), previous = unique.get(key)
    if (!previous) unique.set(key, candidate)
    else if (ipv4(candidate.host) && !ipv4(previous.host)) unique.set(key, { ...candidate, priority: previous.priority, order: previous.order })
    else if (previous.port === undefined && candidate.port !== undefined) previous.port = candidate.port
  }
  return [...unique.entries()].map(([key, candidate]) => {
    const command = commands.get(key)
    return { host: candidate.host, port: command?.port ?? (candidate.port !== undefined ? candidate.port : port),
      ...(command?.username || username ? { username: command?.username ?? username } : {}), ...(password ? { password } : {}) }
  })
}
