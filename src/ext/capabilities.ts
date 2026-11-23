import type { Edition } from './api'

export interface EditionCapabilities {
  readonly overviewHostLimit: number
}

/** Edition policy shared by the main process and renderer; no license state. */
export function getEditionCapabilities(edition: Edition): EditionCapabilities {
  return { overviewHostLimit: edition === 'pro' ? Number.POSITIVE_INFINITY : 5 }
}
