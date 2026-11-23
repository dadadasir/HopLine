import type { HostDisk } from '../../shared/types'
import { shellEscape } from '../shell'

const validMount = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !/[\0\r\n]/.test(value)

/** This path is only a df operand, never a deletion/truncation target. */
export function cleanupDfCommand(mount: string): string {
  if (!validMount(mount)) throw new Error('cleanup.invalidMount')
  return `set -eu\nexport LC_ALL=C\ndf -P -k ${shellEscape(mount)}\n`
}

/** Parse exactly one complete POSIX KiB row for the requested mount; do not infer missing values. */
export function parseCleanupDf(stdout: string, expectedMount: string): HostDisk | null {
  if (!validMount(expectedMount) || typeof stdout !== 'string') return null
  const text = stdout.replace(/\r\n/g, '\n')
  if (!text.endsWith('\n') || /[\0\r]/.test(text)) return null
  const lines = text.slice(0, -1).split('\n')
  if (lines.length !== 2 || !/^Filesystem[ \t]+(?:1024-blocks|1K-blocks)[ \t]+Used[ \t]+Available[ \t]+(?:Capacity|Use%)[ \t]+Mounted on[ \t]*$/.test(lines[0])) return null
  const row = /^(.+?)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(-?\d+)[ \t]+(\d+)%[ \t]+(\/.*)$/.exec(lines[1])
  if (!row) return null
  const [, source, total, used, available, percent, rawMount] = row
  // df variants print mount whitespace literally or as octal escapes. Prefer
  // an exact match so a real directory named /data\040 is not silently renamed.
  const mountpoint = rawMount === expectedMount ? rawMount : rawMount.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
  if (!validMount(mountpoint) || mountpoint !== expectedMount) return null
  const [totalKiB, usedKiB, availableKiB, usagePercent] = [total, used, available, percent].map(Number)
  if (![totalKiB, usedKiB, availableKiB, usagePercent].every(Number.isSafeInteger)) return null
  if (totalKiB <= 0 || usedKiB < 0 || availableKiB < 0 || usedKiB > totalKiB || availableKiB > totalKiB || usagePercent < 0 || usagePercent > 100 || usedKiB + availableKiB > totalKiB) return null
  const [totalBytes, usedBytes, availableBytes] = [totalKiB, usedKiB, availableKiB].map((value) => value * 1024)
  if (![totalBytes, usedBytes, availableBytes].every(Number.isSafeInteger)) return null
  const filesystem = source.trim()
  if (!filesystem) return null
  // Reserved blocks mean usagePercent need not equal usedBytes / totalBytes.
  return { filesystem, mountpoint, totalBytes, usedBytes, availableBytes, usagePercent }
}

/** Concurrent writes may make this negative; a remounted/resized target is not comparable. */
export function cleanupAvailableChange(before: HostDisk | null, after: HostDisk | null): number | null {
  if (!before || !after || before.mountpoint !== after.mountpoint || before.filesystem !== after.filesystem || before.totalBytes !== after.totalBytes) return null
  if (![before.availableBytes, after.availableBytes, before.totalBytes].every(Number.isSafeInteger) || before.totalBytes <= 0 || before.availableBytes < 0 || after.availableBytes < 0 || before.availableBytes > before.totalBytes || after.availableBytes > after.totalBytes) return null
  const delta = after.availableBytes - before.availableBytes
  return Number.isSafeInteger(delta) ? delta : null
}
