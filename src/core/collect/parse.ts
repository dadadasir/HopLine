import type {
  Section, HostSnapshot, HostOs, HostCpu, HostMemory, HostLoad, HostDisk,
  HostListener, HostContainer, HostService, HostWeb, HostCertificate
} from '../../shared/types'

type Unavailable = Extract<Section<never>, { status: 'unavailable' }>
const unavailable = (note: string): Unavailable => ({ status: 'unavailable', reason: 'error', note })
const number = (value?: string): number | null => value && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null
const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

function fields<T extends object>(data: T, note?: string): Section<T> {
  const values = Object.values(data)
  if (values.every((value) => value === null)) return unavailable('No readable fields')
  return { status: note || values.includes(null) ? 'partial' : 'complete', data, ...(note ? { note } : {}) }
}

function rows<T>(text: string, parse: (line: string) => T | null): Section<T[]> {
  const data = lines(text).map(parse)
  if (data.length && data.every((row) => row === null)) return unavailable('No readable rows')
  return { status: data.includes(null) ? 'partial' : 'complete', data: data.filter((row): row is T => row !== null) }
}

function os(text: string): Section<HostOs> {
  const entries = Object.fromEntries([...text.matchAll(/^(\w+)=(.*)$/gm)].map(([, key, value]) =>
    [key, value.replace(/^(['"])(.*)\1$/, '$2').replace(/\\(["\\$`])/g, '$1')]))
  const kernel = lines(text).find((line) => !line.includes('=') && !line.startsWith('#'))?.split(/\s+/)
  return fields({ id: entries.ID ?? null, version: entries.VERSION_ID ?? null, name: entries.PRETTY_NAME ?? entries.NAME ?? null,
    kernel: kernel?.length === 3 ? `${kernel[0]} ${kernel[1]}` : null, architecture: kernel?.length === 3 ? kernel[2] : null })
}

function uptime(text: string): HostSnapshot['uptime'] { return fields({ seconds: number(text.trim().split(/\s+/)[0]) }) }

function cpu(text: string): Section<HostCpu> {
  const cores = number(/^cores (\d+)$/m.exec(text)?.[1])
  const samples = [...text.matchAll(/^cpu\s+(.+)$/gm)].map((match) => match[1].trim().split(/\s+/).slice(0, 8).map(number))
  let usagePercent: number | null = null
  if (samples.length === 2 && samples.every((sample) => sample.length >= 4 && !sample.includes(null))) {
    const [a, b] = samples as number[][]
    if (a.length === b.length) {
      const delta = b.map((value, i) => value - a[i])
      const total = delta.reduce((sum, value) => sum + value, 0)
      const idle = delta[3] + (delta[4] ?? 0)
      if (Number.isFinite(total) && delta.every((value) => value >= 0)) usagePercent = total === 0 ? 0 : Math.round((total - idle) / total * 1000) / 10
    }
  }
  return fields({ cores: cores && Number.isInteger(cores) ? cores : null, usagePercent })
}

function memory(text: string): Section<HostMemory> {
  const entries = Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map(([, key, value]) => [key, Number(value) * 1024]))
  const get = (key: string) => Number.isFinite(entries[key]) ? entries[key] : null
  const estimated = get('MemAvailable') === null
  const fallback = ['MemFree', 'Buffers', 'Cached'].map(get)
  const available = estimated ? fallback.includes(null) ? null : (fallback as number[]).reduce((a, b) => a + b, 0) : get('MemAvailable')
  const availableBytes = available !== null && Number.isFinite(available) ? available : null
  const swap = get('SwapTotal'), free = get('SwapFree')
  return fields({ totalBytes: get('MemTotal'), availableBytes, swapTotalBytes: swap,
    swapUsedBytes: swap !== null && free !== null && free <= swap ? swap - free : null }, estimated ? 'MemAvailable missing; estimated from MemFree+Buffers+Cached' : undefined)
}

function load(text: string): Section<HostLoad> {
  const values = text.trim().split(/\s+/)
  return fields({ one: number(values[0]), five: number(values[1]), fifteen: number(values[2]) })
}

function disk(text: string): Section<HostDisk[]> {
  const [df, mounts] = text.split('#HOPLINE-MOUNTS\n')
  const decode = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
  const types = new Map(lines(mounts ?? '').map((line) => {
    const parts = line.split(/\s+/)
    return [decode(parts[1] ?? ''), parts[2]]
  }))
  const virtual = /^(?:tmpfs|devtmpfs|overlay|squashfs|shm|proc|sysfs|devpts|cgroup2?|securityfs|debugfs|tracefs|pstore|mqueue|hugetlbfs|fusectl|configfs|ramfs|autofs|nsfs)$/
  if (!/^Filesystem\s/m.test(df)) return unavailable('Missing df header')
  const result = rows(df.replace(/^Filesystem[^\n]*\n?/m, ''), (line): HostDisk | null => {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)%\s+(.+)$/.exec(line)
    if (!match) return null
    const [, filesystem, total, used, available, percent, mount] = match
    const values = [total, used, available, percent].map(Number)
    if (!values.every(Number.isFinite) || !values.slice(0, 3).every((value) => Number.isFinite(value * 1024))) return null
    return { filesystem, mountpoint: decode(mount), totalBytes: values[0] * 1024, usedBytes: values[1] * 1024, availableBytes: values[2] * 1024, usagePercent: values[3] }
  })
  if (result.status !== 'unavailable') result.data = result.data.filter((item) => !virtual.test(types.get(item.mountpoint) ?? item.filesystem))
  return result
}

function listeners(text: string): Section<HostListener[]> {
  const result = rows(lines(text).filter((line) => !/^(Active Internet|Proto\s|State\s)/.test(line)).join('\n'), (line): HostListener | null => {
    const parts = line.split(/\s+/), netstat = /^tcp6?$/.test(parts[0])
    if (!netstat && parts[0] !== 'LISTEN') return null
    const endpoint = /^(.*):(\d+)$/.exec(parts[3] ?? '')
    if (!endpoint || Number(endpoint[2]) > 65535) return null
    const process = netstat ? /^\d+\/(.+)$/.exec(parts[6] ?? '')?.[1] : /users:\(\("([^"]+)"/.exec(line)?.[1]
    return { protocol: netstat ? parts[0] as 'tcp' | 'tcp6' : endpoint[1].includes(':') ? 'tcp6' : 'tcp',
      address: endpoint[1].replace(/^\[|\]$/g, ''), port: Number(endpoint[2]), process: process ?? null }
  })
  if (result.status !== 'unavailable' && result.data.some((item) => item.process === null)) {
    result.status = 'partial'
    result.note = 'Process names are not visible'
  }
  return result
}

function docker(text: string): Section<HostContainer[]> {
  return rows(text, (line) => {
    try {
      const item = JSON.parse(line)
      return ['Names', 'Image', 'Status', 'Ports'].every((key) => typeof item?.[key] === 'string')
        ? { name: item.Names, image: item.Image, status: item.Status, ports: item.Ports } : null
    } catch { return null }
  })
}

function services(text: string): Section<HostService[]> {
  return rows(text, (line) => {
    const match = /^(\S+\.service)\s+loaded\s+active\s+running(?:\s+(.*))?$/.exec(line)
    return match ? { name: match[1], description: match[2] ?? '' } : null
  })
}

function web(text: string): Section<HostWeb[]> {
  const data: HostWeb[] = [], seen = new Set<string>()
  let partial = false
  const add = (source: HostWeb['source'], domain: string) => {
    domain = domain.replace(/^['"]|['"]$/g, '')
    if (!domain || domain === '_') return
    if (/[${}~\\]/.test(domain)) { partial = true; return }
    if (!seen.has(`${source}:${domain}`)) { seen.add(`${source}:${domain}`); data.push({ source, domain }) }
  }
  for (const block of text.split('#HOPLINE-SOURCE ').slice(1)) {
    const source = block.slice(0, block.indexOf('\n')), config = block.slice(block.indexOf('\n') + 1).replace(/#[^\n]*/g, '')
    if (/\b(?:include|import)\s/.test(config)) partial = true
    if (source === 'nginx') {
      for (const match of config.matchAll(/\bserver_name\s+([^;]+);/g)) match[1].split(/\s+/).forEach((domain) => add('nginx', domain))
    } else if (source === 'caddy') {
      let depth = 0, pending = ''
      for (const line of lines(config)) {
        if (depth === 0) {
          pending += ` ${line.split('{')[0]}`
          if (line.includes('{') || !line.endsWith(',')) {
            if (!/^\s*(?:\(|import\b)/.test(pending) && pending.trim()) {
              pending.trim().split(/[\s,]+/).forEach((domain) => add('caddy', domain))
              if (!line.includes('{')) { pending = ''; break }
            }
            pending = ''
          }
        }
        depth += (line.match(/{/g)?.length ?? 0) - (line.match(/}/g)?.length ?? 0)
      }
      if (depth !== 0 || pending) partial = true
    } else partial = true
  }
  return { status: partial ? 'partial' : 'complete', data, ...(partial ? { note: 'Some configuration requires expansion or could not be parsed' } : {}) }
}

function certs(text: string): Section<HostCertificate[]> {
  const data: HostCertificate[] = []
  for (const block of text.split(text.includes('#HOPLINE-CERT ') ? /^#HOPLINE-CERT /m : /(?=^notAfter=)/m).filter((part) => part.trim())) {
    const date = /^notAfter=(.+)$/m.exec(block)?.[1]
    const expiresAt = date ? Date.parse(date) : NaN
    data.push({ domain: /^subject=.*?\bCN\s*=\s*([^,\/\n]+)/m.exec(block)?.[1].trim() ?? null, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null, unreferenced: !/^(referenced|served)\n/.test(block) })
  }
  return { status: data.some((item) => item.domain === null || item.expiresAt === null) ? 'partial' : 'complete', data }
}

export function parseCollect(stdout: string, now: number): HostSnapshot {
  const sections = new Map<string, string>()
  for (const match of stdout.replace(/\r\n/g, '\n').matchAll(/^===HOPLINE:(\w+)===\n([\s\S]*?)(?=^===HOPLINE:|$(?![\s\S]))/gm)) {
    sections.set(match[1], match[2])
  }
  function section<T>(name: string, parse: (text: string) => Section<T>): Section<T> {
    const raw = sections.get(name)
    if (raw === undefined) return unavailable('Missing section')
    if (!/\n#HOPLINE-END\n/.test(raw)) return unavailable('Truncated section')
    const failure = /^#HOPLINE-UNAVAILABLE (not-installed|permission-denied|not-applicable|error)(?: (.*))?$/m.exec(raw)
    const warning = /^#HOPLINE-PARTIAL (.*)$/m.exec(raw)
    const text = raw.replace(/^#HOPLINE-(?:UNAVAILABLE|PARTIAL)[^\n]*\n/gm, '').replace(/\n#HOPLINE-END\n[\s\S]*$/, '')
    const error: Unavailable | undefined = failure ? { status: 'unavailable', reason: failure[1] as Unavailable['reason'], note: (failure[2] ?? '').slice(0, 200) } : undefined
    if (error && !text.replace(/^#HOPLINE-.*$/gm, '').trim()) return error
    try {
      const result = parse(text)
      if (error && (result.status === 'unavailable' || (Array.isArray(result.data) && !result.data.length))) return error
      if (result.status !== 'unavailable' && (error || warning)) return { ...result, status: 'partial', note: error?.note ?? warning![1].slice(0, 200) }
      return result
    } catch { return error ?? unavailable('Invalid section data') }
  }
  return { collectedAt: now, os: section('os', os), uptime: section('uptime', uptime), cpu: section('cpu', cpu),
    memory: section('memory', memory), load: section('load', load), disk: section('disk', disk), listeners: section('listeners', listeners),
    docker: section('docker', docker), services: section('services', services), web: section('web', web), certs: section('certs', certs) }
}
