import type { SessionStatus } from '../../../shared/types'
export function cleanNotificationText(value: string, limit: number): string {
  return Array.from(value.replace(/[\x00-\x1f\x7f-\x9f]/g, '')).slice(0, limit).join('')
}
export function shouldNotify(enabled: boolean, active: boolean, focused: boolean): boolean {
  return enabled && (!active || !focused)
}
export function needsAttention(status: SessionStatus, unread: boolean, progressState?: number): boolean {
  return unread || status === 'error' || status === 'closed' || progressState === 2
}
