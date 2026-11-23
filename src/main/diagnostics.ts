import { app, dialog, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isIP } from 'node:net'
import type { StoreData, Vault } from '../core/vault'
import type { SessionHub } from './sessions'
import { watchdogEvents } from './watchdog'

export function redact(text: string, context: { values: string[]; home: string }): string {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const known = [...new Set(context.values)].filter((v) => v && v !== '127.0.0.1' && v !== '::1').sort((a, b) => b.length - a.length)
  const patterns = [
    '(?<key>-----BEGIN [A-Z0-9 ]*KEY-----[\\s\\S]*?(?:-----END [A-Z0-9 ]*KEY-----|$))',
    ...(context.home ? [`(?<home>${escape(context.home)})`] : []),
    '[A-Z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
    '(?<ipv6>(?<![\\w:])(?:[a-f0-9]{0,4}:){2,}(?:(?:\\d{1,3}\\.){3}\\d{1,3}|[a-f0-9]{0,4})(?:%[\\w.-]+)?(?![\\w:]))',
    '(?<ipv4>\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)',
    ...known.map(escape),
    '[A-Z0-9+/_-]{32,}={0,2}'
  ]
  return text.replace(new RegExp(patterns.join('|'), 'gi'), (value, ...args) => {
    const groups = args.at(-1)
    if (groups.home) return '~'
    if (groups.ipv4 || groups.ipv6) {
      if (value === '127.0.0.1' || value === '::1' || !isIP(value.split('%')[0])) return value
    }
    return '[REDACTED]'
  })
}

export function sessionCounts(sessions: SessionHub): { sessions: number; transfers: number } {
  const open = sessions.list()
  return { sessions: open.length, transfers: open.reduce((n, session) => n + sessions.jobsFor(session.id).length, 0) }
}

export function buildDiagnostics(data: StoreData, runtime: Record<string, unknown>, events: string[], logs: string, home: string): string {
  const hosts = data.hosts.filter((host) => !host.deletedAt)
  const tally = (values: (string | number)[]) => values.reduce<Record<string, number>>((out, key) => { out[key] = (out[key] ?? 0) + 1; return out }, {})
  const { language, theme, fontSize, transferConcurrency, packSmallFiles, sidebarCollapsed } = data.settings
  const report = {
    runtime, settings: { language, theme, fontSize, transferConcurrency, packSmallFiles, sidebarCollapsed },
    hosts: { total: hosts.length, authentication: tally(hosts.map((h) => h.authType)), jumpDepth: tally(hosts.map((h) => h.jumps.length)),
      jumpAuthentication: tally(hosts.flatMap((h) => h.jumps.map((j) => j.authType))), forwards: tally(hosts.flatMap((h) => h.forwards.map((f) => f.type))) }
  }
  const values: string[] = []
  const collect = (value: unknown, key = '') => {
    if (typeof value === 'string' && (/Enc$/.test(key) || ['host', 'username', 'name', 'url', 'endpoint', 'accessKeyId', 'verifier'].includes(key))) values.push(value)
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k)
  }
  collect(data)
  const context = { values, home }
  // Redact complete key blocks before limiting lines, which may cut a block in half.
  const safeLogs = redact(logs, context).split('\n').filter(Boolean).slice(-2000).join('\n')
  return `${redact(JSON.stringify(report, null, 2), context)}\n\nWatchdog (latest 50)\n${redact(events.slice(-50).join('\n'), context)}\n\nLogs (latest 2000 lines)\n${safeLogs}`
}

export async function recentLogs(dir: string): Promise<string> {
  const files = await Promise.all(['hopline.1.log', 'hopline.log'].map(async (name) => {
    try { return await fs.readFile(path.join(dir, name), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }))
  return files.join('\n').split(/(?=^\d{4}-\d{2}-\d{2}T)/m).filter(Boolean).sort().join('')
}

export function createDiagnostics(vault: Vault, sessions: SessionHub, userData: string, getWindow: () => BrowserWindow | null) {
  let preview: string | null = null, saving = false
  return {
    preview: async () => {
      preview = buildDiagnostics(vault.snapshot(), {
        version: app.getVersion(), edition: typeof __HOPLINE_EDITION__ === 'undefined' ? 'community' : __HOPLINE_EDITION__,
        electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
        platform: process.platform, release: os.release(), arch: process.arch, ...sessionCounts(sessions)
      }, watchdogEvents(), await recentLogs(path.join(userData, 'logs')), os.homedir())
      return preview
    },
    save: async (expected: string) => {
      const win = getWindow(), text = preview
      if (!win || text === null || saving) return false
      if (expected !== text) throw new Error('Diagnostics preview changed; please reopen it.')
      saving = true
      try {
        const now = new Date(), pad = (n: number) => String(n).padStart(2, '0')
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
        const result = await dialog.showSaveDialog(win, { defaultPath: `hopline-diagnostics-${stamp}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] })
        if (result.canceled || !result.filePath) return false
        await fs.writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600 })
        shell.showItemInFolder(result.filePath)
        return true
      } finally { saving = false }
    }
  }
}
