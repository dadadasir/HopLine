import type { CollectionIntervalMinutes, CollectRecord } from '../shared/types'

// Twice the ordinary background collection interval. A cached observation is
// still available as history, but cannot indefinitely imply a healthy machine.
export const SNAPSHOT_MAX_AGE_MS = 10 * 60_000
export function normalizeCollectionInterval(value: unknown): CollectionIntervalMinutes {
  return value === 1 || value === 15 ? value : 5
}

export function snapshotIsStale(record: CollectRecord | undefined, now = Date.now(), intervalMinutes = 5): boolean {
  if (!record?.snapshot) return false
  const times = [record.updatedAt ?? NaN, record.snapshot.collectedAt]
  return times.some(at => !Number.isFinite(at) || at > now + 60_000) || now - Math.min(...times) >= Math.max(SNAPSHOT_MAX_AGE_MS, 2 * intervalMinutes * 60_000)
}
