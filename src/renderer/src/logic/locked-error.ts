import { MASTER_PASSWORD_REQUIRED } from '../../../shared/types'

export function isLockedError(error: unknown): boolean {
  // Electron invoke preserves the message, but drops custom Error properties.
  return error instanceof Error && (error.name === 'LockedError' || error.message.includes(MASTER_PASSWORD_REQUIRED))
}
