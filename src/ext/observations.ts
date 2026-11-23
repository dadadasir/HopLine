import type { CollectRecord, CollectRecords } from '../shared/types'

/** A single shared collection attempt, independent of any extension's rules. */
export interface BackgroundCollection {
  status: 'success' | 'connection-failed' | 'needs-attention' | 'unavailable'
  attemptId: string
  at: number
  record: CollectRecord
  reason?: 'authentication' | 'host-key' | 'locked' | 'connection' | 'collection' | 'stopped'
}

export interface ExtensionObservations {
  records: CollectRecords
  security: Record<string, { score: number; collectedAt: number }>
}
