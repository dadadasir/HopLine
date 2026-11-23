import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const WINDOWS_OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

const WINDOWS_PIPE_RE = /^[/\\][/\\]\.[/\\]pipe[/\\].+/i
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/

export function isWindowsPath(value: string): boolean {
  return WINDOWS_DRIVE_RE.test(value) || value.startsWith('\\\\')
}

export function isWindowsNamedPipe(value: string): boolean {
  return WINDOWS_PIPE_RE.test(value.trim())
}

export function normalizeWindowsPipe(value: string): string {
  const trimmed = value.trim()
  if (!WINDOWS_PIPE_RE.test(trimmed)) return trimmed
  const suffix = trimmed.replace(/^[/\\][/\\]\.[/\\]pipe[/\\]/i, '').replaceAll('/', '\\')
  return `\\\\.\\pipe\\${suffix}`
}

/** Named pipes and Pageant are kernel/IPC endpoints rather than regular disk files. */
export function isVirtualAgentTarget(value: string, platform = process.platform): boolean {
  const trimmed = value.trim()
  if (isWindowsNamedPipe(trimmed)) return true
  return platform === 'win32' && trimmed.toLowerCase() === 'pageant'
}

/**
 * Windows 10/11 OpenSSH Agent and 1Password for Windows listen on the standard
 * named pipe without setting SSH_AUTH_SOCK in user environment variables.
 */
export function defaultAgentSocket(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (env.SSH_AUTH_SOCK !== undefined) return env.SSH_AUTH_SOCK
  return platform === 'win32' ? WINDOWS_OPENSSH_PIPE : undefined
}

export function expandLocalPath(
  value: string,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  if (platform === 'win32' && trimmed.toLowerCase() === 'pageant') return 'pageant'
  if (isWindowsNamedPipe(trimmed)) return platform === 'win32' ? normalizeWindowsPipe(trimmed) : trimmed

  const winStyle = platform === 'win32' || isWindowsPath(home)
  const paths = winStyle ? path.win32 : path.posix

  let expanded = trimmed.replace(/%USERPROFILE%/gi, env.USERPROFILE || home)
  if (winStyle) {
    if (env.LOCALAPPDATA) expanded = expanded.replace(/%LOCALAPPDATA%/gi, env.LOCALAPPDATA)
    if (env.APPDATA) expanded = expanded.replace(/%APPDATA%/gi, env.APPDATA)
  }

  if (expanded === '~') return home
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    return paths.join(home, expanded.slice(2))
  }
  return expanded
}

export function resolveWindowsShell(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync
): { file: string; args: string[] } {
  const explicit = env.HOPLINE_SHELL?.trim()
  if (explicit) return { file: explicit, args: [] }

  const pathEntries = (env.PATH ?? env.Path ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)

  const findIn = (exe: string, extras: string[]): string | null => {
    for (const dir of pathEntries) {
      const candidate = path.win32.join(dir, exe)
      if (exists(candidate)) return candidate
    }
    for (const candidate of extras) {
      if (candidate && exists(candidate)) return candidate
    }
    return null
  }

  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA || ''
  const pwsh = findIn('pwsh.exe', [
    path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.win32.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
    localAppData ? path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe') : ''
  ])
  if (pwsh) return { file: pwsh, args: ['-NoLogo'] }

  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows'
  const winPs = findIn('powershell.exe', [
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ])
  if (winPs) return { file: winPs, args: ['-NoLogo'] }

  return { file: env.COMSPEC || env.ComSpec || 'cmd.exe', args: [] }
}

const TRANSIENT_WIN_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const SLEEP_BUF = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null

function sleepSync(ms: number): void {
  if (SLEEP_BUF) {
    try { Atomics.wait(SLEEP_BUF, 0, 0, ms); return } catch { /* main thread fallback below */ }
  }
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { /* bounded <= 30ms spin fallback */ }
}

/**
 * Windows Defender / Search Indexer can briefly hold a shared handle on a target
 * file during atomic replacement, causing transient EPERM/EACCES/EBUSY errors.
 */
export function renameReplaceSync(
  from: string,
  to: string,
  platform = process.platform,
  rename: (source: string, destination: string) => void = fs.renameSync
): void {
  const delays = platform === 'win32' ? [5, 15, 30] : []
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? ''
      if (attempt >= delays.length || !TRANSIENT_WIN_RENAME_CODES.has(code)) throw error
      sleepSync(delays[attempt]!)
    }
  }
}

export async function renameReplaceAsync(
  from: string,
  to: string,
  platform = process.platform,
  rename: (source: string, destination: string) => Promise<void> = fs.promises.rename
): Promise<void> {
  const delays = platform === 'win32' ? [10, 25, 50, 100] : []
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? ''
      if (attempt >= delays.length || !TRANSIENT_WIN_RENAME_CODES.has(code)) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]!))
    }
  }
}

export function safeChmodSync(target: string | number, mode: number, platform = process.platform): void {
  try {
    if (typeof target === 'number') fs.fchmodSync(target, mode)
    else fs.chmodSync(target, mode)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (platform === 'win32' && (code === 'ENOSYS' || code === 'EINVAL' || code === 'EPERM')) return
    throw error
  }
}

/**
 * Rewrites a file path inside Electron's `app.asar` to its `app.asar.unpacked`
 * counterpart when that unpacked binary/asset exists on real OS disk.
 */
export function resolveAsarUnpackedPath(
  filePath: string,
  exists: (file: string) => boolean = fs.existsSync
): string {
  const unpacked = filePath.replace(/([/\\])app\.asar([/\\])/i, '$1app.asar.unpacked$2')
  return unpacked !== filePath && exists(unpacked) ? unpacked : filePath
}

/**
 * Resolves self-contained unpacked native packages (such as `node-pty`, which has
 * zero external npm runtime dependencies) on disk when running inside `app.asar`.
 * Never use this for packages that `require()` sibling dependencies inside `app.asar`.
 */
export function resolveAsarUnpackedModule(
  specifier: string,
  callerUrl: string,
  exists: (file: string) => boolean = fs.existsSync
): string {
  try {
    const callerPath = callerUrl.startsWith('file:') ? fileURLToPath(callerUrl) : callerUrl
    const match = /[/\\]app\.asar[/\\]/i.exec(callerPath)
    if (!match) return specifier
    const sep = callerPath.includes('\\') && !callerPath.includes('/') ? '\\' : path.sep
    const paths = sep === '\\' ? path.win32 : path
    const unpackedRoot = `${callerPath.slice(0, match.index)}${sep}app.asar.unpacked${sep}node_modules`
    const target = paths.join(unpackedRoot, ...specifier.split('/'))
    if (exists(target) || exists(`${target}.js`) || exists(paths.join(target, 'package.json'))) {
      return target
    }
  } catch {
    // Fall back to standard module resolution.
  }
  return specifier
}
