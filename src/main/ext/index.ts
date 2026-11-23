import { ipcMain, type BrowserWindow } from 'electron'
import type { MainExtContext } from '../../ext/api'
import { logError, logInfo } from '../logger'
import { registerMainExtensions } from './registry'
import type { MainRegistryDeps } from './registry'

const disposers: (() => void)[] = []
export function disposeMainExtensions(): void {
  for (const dispose of disposers.splice(0).reverse()) dispose()
}

export async function loadMainExtensions(
  getWindow: () => BrowserWindow | null,
  userData: string,
  listHosts: MainExtContext['listHosts'],
  services?: MainRegistryDeps['services']
): Promise<void> {
  let extensions
  try {
    extensions = (await import('@hopline/pro-main')).default
  } catch (error) {
    logError('扩展导入失败 / Extension import failed', error)
    return
  }
  await registerMainExtensions(extensions, {
    ipc: ipcMain, getWindow, userData, listHosts, services,
    onDispose: callback => { disposers.push(callback) },
    log: { info: logInfo, error: logError }
  })
}
