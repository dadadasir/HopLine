import { getEditionCapabilities, type EditionCapabilities } from '../../../ext/capabilities'
import { useSyncExternalStore } from 'react'

let capabilities: EditionCapabilities = getEditionCapabilities('community')
const listeners = new Set<() => void>()

export function getRendererCapabilities(): EditionCapabilities {
  return capabilities
}
export function setRendererCapabilities(value: EditionCapabilities): void {
  const limit = value?.overviewHostLimit
  const next = typeof __HOPLINE_EDITION__ !== 'undefined' && __HOPLINE_EDITION__ === 'pro' && (limit === Infinity || Number.isSafeInteger(limit) && limit >= 1) ? limit : 5
  if (capabilities.overviewHostLimit === next) return
  capabilities = { overviewHostLimit: next }
  for (const listener of listeners) listener()
}
export function useRendererCapabilities(): EditionCapabilities {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, getRendererCapabilities, getRendererCapabilities)
}
