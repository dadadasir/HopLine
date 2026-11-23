export interface UpdatePreferences {
  automatic: boolean
  lastAttemptAt: number | null
}

export interface UpdateRelease {
  version: string
  url: string
  summary: string
}

export type UpdateErrorReason = 'network' | 'timeout' | 'invalid' | 'unavailable' | 'rate-limit' | 'storage'

export type UpdateCheckResult =
  | { status: 'available'; release: UpdateRelease }
  | { status: 'current' }
  | { status: 'error'; reason: UpdateErrorReason }
