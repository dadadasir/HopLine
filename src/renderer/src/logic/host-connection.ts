import { normalizeConnectionTimeout, normalizeKeepaliveInterval } from '../../../core/host-connection'

const seconds = (draft: string): number | null => {
  const value = draft.trim()
  return value === '' ? null : /^\d+$/.test(value) ? Number(value) : NaN
}

export function connectionTimingDraft(timeout: string, keepalive: string) {
  return {
    connectionTimeoutSec: normalizeConnectionTimeout(seconds(timeout)),
    keepaliveIntervalSec: normalizeKeepaliveInterval(seconds(keepalive))
  }
}
