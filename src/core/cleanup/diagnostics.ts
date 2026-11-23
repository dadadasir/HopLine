import { shellEscape } from '../shell'

export type CleanupDiagnosticSection<T> = { status: 'available'; data: T } | { status: 'unavailable'; reason: string }
export interface CleanupDeletedFile { pid: number; process: string; bytes: number }
export interface CleanupInodes { mountpoint: string; used: number; total: number; usagePercent: number }
export interface CleanupLogFile { path: string; bytes: number; rotated: boolean }
export interface CleanupDiagnostics {
  deleted: CleanupDiagnosticSection<{ files: CleanupDeletedFile[]; totalBytes: number }>
  inodes: CleanupDiagnosticSection<CleanupInodes[]> & { unavailableMounts?: string[] }
  logs: CleanupDiagnosticSection<CleanupLogFile[]>
}

const deletedScript = String.raw`
[ "$(id -u)" = 0 ] || unavailable permissionDenied
if command -v lsof >/dev/null 2>&1; then
  # Field output includes process, descriptor, type, device, inode and exact size.
  # lsof exits 1 with no output when no matching open file exists.
  code=0
  data=$(lsof -nP +L1 -FpcfDits 2>&1) || code=$?
  if [ "$code" -ne 0 ] && { [ "$code" -ne 1 ] || [ -n "$data" ]; }; then
    case "$data" in *'Permission denied'*|*'permission denied'*|*'Operation not permitted'*) unavailable permissionDenied ;; *) unavailable commandFailed ;; esac
  fi
  printf '#HOPLINE-SOURCE lsof\n%s\n' "$data"
else
  for tool in readlink stat cat tr; do command -v "$tool" >/dev/null 2>&1 || unavailable toolsMissing; done
  [ -d /proc/1/fd ] || unavailable procUnavailable
  printf '#HOPLINE-SOURCE proc\n'
  found=0
  for fds in /proc/[0-9]*/fd; do
    [ -d "$fds" ] || continue
    found=1
    [ -r "$fds" ] && [ -x "$fds" ] || unavailable permissionDenied
    proc=${'${fds%/fd}'}; pid=${'${proc##*/}'}
    process=$(cat "$proc/comm" 2>/dev/null) || { [ ! -d "$proc" ] && continue; unavailable permissionDenied; }
    process=$(printf '%s' "$process" | tr '\t\r\n' '   ')
    for fd in "$fds"/*; do
      [ -L "$fd" ] || continue
      target=$(readlink "$fd" 2>/dev/null) || { [ ! -L "$fd" ] && continue; unavailable permissionDenied; }
      case "$target" in *' (deleted)') ;; *) continue ;; esac
      # Only ordinary files occupy reclaimable file data; sockets and pipes do not.
      [ -f "$fd" ] || continue
      metadata=$(stat -Lc '%d %i %s' "$fd" 2>/dev/null) || { [ ! -L "$fd" ] && continue; unavailable permissionDenied; }
      printf '%s\t%s\t%s\n' "$pid" "$metadata" "$process"
    done
  done
  [ "$found" = 1 ] || unavailable procUnavailable
fi`

const inodeScript = String.raw`
command -v df >/dev/null 2>&1 || unavailable toolsMissing
df -P -i`

const logsScript = String.raw`
for tool in find stat od tr sort awk; do command -v "$tool" >/dev/null 2>&1 || unavailable toolsMissing; done
[ -d /var/log ] || unavailable commandFailed
[ -r /var/log ] && [ -x /var/log ] || unavailable permissionDenied
# Hex paths keep spaces, tabs and unusual names from forging rows or section markers.
files=$(find /var/log -xdev -type f -exec sh -c '
  set -eu
  export LC_ALL=C
  for file do
    [ -f "$file" ] && [ ! -L "$file" ] || exit 1
    bytes=$(stat -c %s "$file")
    name=$(printf "%s" "$file" | od -An -v -tx1 | tr -d " \n")
    printf "%s %s\n" "$bytes" "$name"
  done
' sh {} +)
printf '%s\n' "$files" | sort -nr | awk 'NF && NR <= 12'`

/** A single read-only SSH execution. A failed child cannot prevent later sections. */
export const CLEANUP_DIAGNOSTICS_SCRIPT = `#!/bin/sh
set -eu
export LC_ALL=C
section() {
  printf '===HOPLINE-CLEANUP:%s===\\n' "$1"
  if data=$(sh -c "$2" 2>&1); then printf '%s\\n' "$data"
  else
    case "$data" in *'Permission denied'*|*'permission denied'*|*'Operation not permitted'*) printf '#HOPLINE-UNAVAILABLE permissionDenied\\n' ;;
      *) printf '#HOPLINE-UNAVAILABLE commandFailed\\n' ;; esac
  fi
  printf '#HOPLINE-END\\n'
}
${Object.entries({ deleted: deletedScript, inodes: inodeScript, logs: logsScript }).map(([name, body]) => `section ${name} ${shellEscape(`set -eu\nexport LC_ALL=C\nunavailable() { printf '#HOPLINE-UNAVAILABLE %s\\n' "$1"; exit 0; }\n${body}`)}`).join('\n')}
`

const unavailable = (key: string): { status: 'unavailable'; reason: string } => ({ status: 'unavailable', reason: `cleanup.diagnostic.${key}` })
const integer = (value: string): number => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('invalidData')
  return Number(value)
}
const textRows = (text: string): string[] => text.split('\n').filter((line) => line.length > 0)

function deleted(text: string): { files: CleanupDeletedFile[]; totalBytes: number } {
  const rows = textRows(text), source = rows.shift(), files: CleanupDeletedFile[] = []
  const sizes = new Map<string, number>(), seen = new Set<string>()
  const add = (pidText: string, process: string, device: string, inode: string, size: string) => {
    const pid = integer(pidText), bytes = integer(size)
    if (!/^\d+$/.test(inode)) throw new Error('invalidData')
    if (!pid || !process || /[\0\r\n]/.test(process) || !/^(?:0x[0-9a-f]+|\d+)$/i.test(device)) throw new Error('invalidData')
    const key = `${device}:${inode}`, owner = `${pid}:${key}`
    // Conflicting measurements indicate a race; do not invent a snapshot by taking a maximum.
    if (sizes.has(key) && sizes.get(key) !== bytes) throw new Error('invalidData')
    sizes.set(key, bytes)
    if (!seen.has(owner)) { seen.add(owner); files.push({ pid, process, bytes }) }
  }
  if (source === '#HOPLINE-SOURCE lsof') {
    let pid = '', process = '', file: Record<string, string> | undefined
    const flush = () => {
      if (!file) return
      if (!file.t) throw new Error('invalidData')
      if (file.t === 'REG') add(pid, process, file.D ?? '', file.i ?? '', file.s ?? '')
      file = undefined
    }
    for (const row of rows) {
      const key = row[0], value = row.slice(1)
      if (key === 'p') { flush(); pid = value; process = ''; integer(pid) }
      else if (key === 'c' && !file && pid) process = value
      else if (key === 'f' && pid && process) { flush(); file = {} }
      else if (file && ['t', 'D', 'i', 's'].includes(key) && !(key in file)) file[key] = value
      else throw new Error('invalidData')
    }
    flush()
  } else if (source === '#HOPLINE-SOURCE proc') {
    for (const row of rows) {
      const match = /^(\d+)\t(\d+) (\d+) (\d+)\t([^\0\r\n]+)$/.exec(row)
      if (!match) throw new Error('invalidData')
      add(match[1], match[5], match[2], match[3], match[4])
    }
  } else throw new Error('invalidData')
  const totalBytes = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0)
  if (!Number.isSafeInteger(totalBytes)) throw new Error('invalidData')
  return { files: files.sort((a, b) => b.bytes - a.bytes || a.pid - b.pid), totalBytes }
}

function inodes(text: string): { data: CleanupInodes[]; unavailableMounts: string[] } {
  const rows = textRows(text)
  if (!/^Filesystem\s+Inodes\s+IUsed\s+IFree\s+IUse%\s+Mounted on\s*$/.test(rows.shift() ?? '')) throw new Error('invalidData')
  if (!rows.length) throw new Error('invalidData')
  const unavailableMounts: string[] = []
  const data = rows.flatMap((row) => {
    const match = /^(\S+)\s+(\d+|-)\s+(\d+|-)\s+(\d+|-)\s+(\d+%|-)\s+(.+)$/.exec(row)
    if (!match) throw new Error('invalidData')
    const mountpoint = match[6].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
    if (!mountpoint.startsWith('/') || /[\0\r\n]/.test(mountpoint)) throw new Error('invalidData')
    if (match.slice(2, 6).includes('-') || match[2] === '0') { unavailableMounts.push(mountpoint); return [] }
    const total = integer(match[2]), used = integer(match[3]), free = integer(match[4]), usagePercent = integer(match[5].slice(0, -1))
    if (used > total || free > total || usagePercent > 100) throw new Error('invalidData')
    return [{ mountpoint, total, used, usagePercent }]
  })
  if (!data.length) throw new Error('inodeUnsupported')
  return { data, unavailableMounts }
}

function logs(text: string): CleanupLogFile[] {
  return textRows(text).map((row) => {
    const match = /^(\d+) ([a-f0-9]+)$/.exec(row)
    if (!match || match[2].length % 2) throw new Error('invalidData')
    const path = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(match[2].match(/../g)!, (byte) => parseInt(byte, 16)))
    if (!path.startsWith('/') || /[\0\r\n]/.test(path)) throw new Error('invalidData')
    return { path, bytes: integer(match[1]), rotated: /\.(?:gz|[0-9]|old)$/.test(path) }
  }).sort((a, b) => b.bytes - a.bytes).slice(0, 12)
}

export function parseCleanupDiagnostics(output: string): CleanupDiagnostics {
  const sections = new Map<string, string[]>(), reasons = new Set(['permissionDenied', 'toolsMissing', 'procUnavailable', 'commandFailed'])
  for (const match of output.replace(/\r\n/g, '\n').matchAll(/^===HOPLINE-CLEANUP:(\w+)===\n([\s\S]*?)(?=^===HOPLINE-CLEANUP:|$(?![\s\S]))/gm)) {
    const blocks = sections.get(match[1]) ?? []; blocks.push(match[2]); sections.set(match[1], blocks)
  }
  const section = <T>(name: string, parse: (text: string) => T): CleanupDiagnosticSection<T> => {
    const blocks = sections.get(name)
    if (!blocks) return unavailable('missingSection')
    if (blocks.length !== 1) return unavailable('invalidData')
    const raw = blocks[0]
    if (!raw.endsWith('#HOPLINE-END\n')) return unavailable('truncated')
    const body = raw.slice(0, -'#HOPLINE-END\n'.length)
    const failures = [...body.matchAll(/^#HOPLINE-UNAVAILABLE (\w+)$/gm)]
    if (failures.length) return unavailable(reasons.has(failures[0][1]) ? failures[0][1] : 'commandFailed')
    try { return { status: 'available', data: parse(body) } }
    catch (error) { return unavailable(error instanceof Error && error.message === 'inodeUnsupported' ? 'inodeUnsupported' : 'invalidData') }
  }
  const inodeResult = section('inodes', inodes)
  return { deleted: section('deleted', deleted), inodes: inodeResult.status === 'unavailable' ? inodeResult : {
    status: 'available', data: inodeResult.data.data,
    ...(inodeResult.data.unavailableMounts.length ? { unavailableMounts: inodeResult.data.unavailableMounts } : {})
  }, logs: section('logs', logs) }
}
