import { useSyncExternalStore } from 'react'
import { mergeRendererExtensions } from './registry'

export let rendererExtensions = mergeRendererExtensions([])
const listeners = new Set<() => void>()
export const extensionsReady = import('@hopline/pro-renderer').then(({ default: extensions }) => {
  rendererExtensions = mergeRendererExtensions(extensions)
  for (const warning of rendererExtensions.warnings) console.warn(warning)
  for (const listener of listeners) listener()
}).catch((error: unknown) => console.error('扩展导入失败 / Extension import failed', error))

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function useRendererExtensions() {
  return useSyncExternalStore(subscribe, () => rendererExtensions)
}
