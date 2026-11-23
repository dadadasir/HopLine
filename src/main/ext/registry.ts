import type { BrowserWindow, ipcMain } from 'electron'
import type { MainExtContext, MainExtension } from '../../ext/api'
import { proChannel } from '../../ext/channel'
import { makeCallerGuard } from '../ipc'

export interface MainRegistryDeps {
  ipc: Pick<typeof ipcMain, 'handle' | 'removeHandler'>
  getWindow(): BrowserWindow | null
  userData: string
  listHosts: MainExtContext['listHosts']
  log: MainExtContext['log']
  services?: Pick<MainExtContext, 'version' | 'language' | 'listGroups' | 'listSnippets' | 'sudoMode' | 'execute' | 'appendOperation' | 'setCapabilities' | 'collect' | 'observations' | 'onObservations' | 'runtime' | 'onRuntime' | 'openMainWindow'> & {
    secretsFor?(owner: string): NonNullable<MainExtContext['secrets']>
  }
  onDispose?: (callback: () => void) => void
}

export async function registerMainExtensions(extensions: readonly MainExtension[], deps: MainRegistryDeps): Promise<void> {
  const guard = makeCallerGuard(deps.getWindow)
  const channels = new Set<string>()
  const ids = new Set<string>()
  for (const extension of extensions) {
    if (ids.has(extension.id)) {
      deps.log.error(`扩展 id 重复 / Duplicate extension id: ${extension.id}`)
      continue
    }
    ids.add(extension.id)
    const owned = new Set<string>()
    let active = true
    const disposers: (() => void)[] = []
    const assertActive = () => { if (!active) throw new Error('扩展已停用 / Extension is inactive') }
    const unavailable = () => { throw new Error('扩展服务不可用 / Extension service unavailable') }
    const dispose = () => {
      if (!active) return
      active = false
      for (const callback of disposers.splice(0).reverse()) {
        try { callback() } catch { deps.log.error('扩展清理失败 / Extension cleanup failed') }
      }
      for (const channel of owned) { deps.ipc.removeHandler(channel); channels.delete(channel) }
      deps.services?.setCapabilities({ overviewHostLimit: 5 })
    }
    const ctx: MainExtContext = {
      edition: 'pro',
      version: deps.services?.version ?? '',
      language: () => { assertActive(); return deps.services?.language() ?? 'zh' },
      userData: deps.userData,
      handle(name, handler) {
        if (!active) throw new Error('扩展已停用 / Extension is inactive')
        const channel = proChannel(name)
        if (channel.length > 64 || !/^[a-z0-9:._-]+$/.test(channel)) {
          throw new Error('扩展通道名无效 / Invalid extension channel')
        }
        if (channels.has(channel)) throw new Error(`扩展通道重复 / Duplicate extension channel: ${channel}`)
        deps.ipc.handle(channel, (event, ...args: unknown[]) => {
          guard(event)
          return handler(...args)
        })
        channels.add(channel)
        owned.add(channel)
      },
      emit(type, payload) {
        if (!active) return
        const win = deps.getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('pro:event', { type, payload })
      },
      listHosts: () => { assertActive(); return structuredClone(deps.listHosts()) },
      listGroups: () => { assertActive(); return structuredClone(deps.services?.listGroups() ?? []) },
      listSnippets: () => { assertActive(); return structuredClone(deps.services?.listSnippets() ?? []) },
      sudoMode: (id) => { assertActive(); return deps.services?.sudoMode(id) ?? unavailable() },
      execute: (id, request) => { assertActive(); return deps.services?.execute(id, request) ?? unavailable() },
      appendOperation: (id, row) => { assertActive(); if (deps.services) deps.services.appendOperation(id, structuredClone(row)); else unavailable() },
      setCapabilities: (value) => { assertActive(); if (deps.services) deps.services.setCapabilities(value); else unavailable() },
      secrets: {
        has: slot => { assertActive(); return deps.services?.secretsFor?.(extension.id).has(slot) ?? unavailable() },
        get: slot => { assertActive(); const service = deps.services?.secretsFor?.(extension.id); return service ? service.get(slot) : unavailable() },
        set: (slot, value) => { assertActive(); const service = deps.services?.secretsFor?.(extension.id); if (service) service.set(slot, value); else unavailable() }
      },
      collect: id => { assertActive(); return deps.services?.collect?.(id) ?? unavailable() },
      observations: () => { assertActive(); return structuredClone(deps.services?.observations?.() ?? unavailable()) },
      onObservations: listener => {
        assertActive()
        const off = deps.services?.onObservations?.(value => { if (active) listener(structuredClone(value)) }) ?? unavailable()
        disposers.push(off); return off
      },
      runtime: () => { assertActive(); return { ...(deps.services?.runtime?.() ?? unavailable()) } },
      onRuntime: listener => {
        assertActive()
        const off = deps.services?.onRuntime?.(value => { if (active) listener({ ...value }) }) ?? unavailable()
        disposers.push(off); return off
      },
      openMainWindow: () => { assertActive(); if (deps.services?.openMainWindow) deps.services.openMainWindow(); else unavailable() },
      onDispose: (callback) => { assertActive(); disposers.push(callback) },
      log: deps.log
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => extension.setup(ctx)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Extension setup timed out (10s)')), 10_000)
        })
      ])
      deps.onDispose?.(dispose)
    } catch (error) {
      dispose()
      deps.log.error(`扩展加载失败 / Extension setup failed: ${extension.id}`, error)
    } finally {
      clearTimeout(timer)
    }
  }
}
