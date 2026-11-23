/** Compare enumerable own fields of plain objects or arrays using Object.is. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false
  const prototype = Object.getPrototypeOf(a)
  if (!Array.isArray(a) && prototype !== Object.prototype && prototype !== null) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key)
    && Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** Cache the selection as well as its source snapshot for useSyncExternalStore. */
export function createSelectorSnapshot<S, T>(
  getState: () => S, selector: (state: S) => T, isEqual: (a: T, b: T) => boolean = Object.is
): () => T {
  let initialized = false
  let snapshot: S
  let selection: T
  return () => {
    const nextSnapshot = getState()
    if (initialized && Object.is(snapshot, nextSnapshot)) return selection
    const nextSelection = selector(nextSnapshot)
    if (!initialized || !isEqual(selection, nextSelection)) selection = nextSelection
    snapshot = nextSnapshot
    initialized = true
    return selection
  }
}
