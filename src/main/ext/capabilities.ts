import { getEditionCapabilities, type EditionCapabilities } from '../../ext/capabilities'

let capabilities: EditionCapabilities = getEditionCapabilities('community')
const listeners = new Set<(value: EditionCapabilities) => void>()

export function getMainCapabilities(): EditionCapabilities {
  return { ...capabilities }
}

export function setMainCapabilities(value: EditionCapabilities): void {
  const limit = value.overviewHostLimit
  if (!(limit === Infinity || Number.isSafeInteger(limit) && limit >= 1)) throw new Error('扩展能力不合法 / Invalid extension capability')
  const next = typeof __HOPLINE_EDITION__ !== 'undefined' && __HOPLINE_EDITION__ === 'pro' ? limit : 5
  if (capabilities.overviewHostLimit === next) return
  capabilities = { overviewHostLimit: next }
  for (const listener of listeners) listener(getMainCapabilities())
}
export function subscribeMainCapabilities(listener: (value: EditionCapabilities) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
