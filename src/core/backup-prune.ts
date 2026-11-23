export interface BackupFileInfo {
  name: string
  mtimeMs: number
}

export interface PruneOptions {
  /** Always retain this many newest files. */
  keep: number
  /** Files beyond `keep` are deleted only after they are also older than this. */
  maxAgeMs: number
}

export const DEFAULT_PRUNE: PruneOptions = {
  keep: 10,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000
}

/**
 * Keep the newest `keep` backups.
 * Among the rest, delete only those older than `maxAgeMs`.
 * A recent burst can therefore leave more than `keep` files on disk.
 */
export function selectBackupsToPrune(
  files: BackupFileInfo[],
  now: number,
  options: PruneOptions = DEFAULT_PRUNE
): string[] {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
  const doomed: string[] = []
  sorted.forEach((file, index) => {
    if (index >= options.keep && now - file.mtimeMs > options.maxAgeMs) {
      doomed.push(file.name)
    }
  })
  return doomed
}
