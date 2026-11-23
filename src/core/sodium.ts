import type sodiumModule from 'libsodium-wrappers-sumo'

export type Sodium = typeof sodiumModule

let loaded: Sodium | null = null
let pending: Promise<Sodium> | null = null

export function getSodium(): Promise<Sodium> {
  if (loaded) return Promise.resolve(loaded)
  if (!pending) {
    pending = import('libsodium-wrappers-sumo').then(async (mod) => {
      const instance = ('default' in mod && mod.default ? mod.default : mod) as unknown as Sodium
      await instance.ready
      loaded = instance
      return instance
    }).catch((error: unknown) => {
      pending = null
      throw error
    })
  }
  return pending
}

export function getLoadedSodium(): Sodium {
  if (!loaded) throw new Error('加密模块尚未初始化')
  return loaded
}
