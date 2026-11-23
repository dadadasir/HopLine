import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'

const enabled = process.env.HOPLINE_PERF === '1'
const trace = enabled && process.argv.includes('--hopline-perf-trace')
const startedAt = enabled ? performance.now() : 0
const stages = new Set<string>()

/** Optional diagnostics only; never replaces the parent process's first-paint clock. */
export function perfStage(name: string): void {
  if (!trace || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || stages.has(name)) return
  stages.add(name)
  console.log(`HOPLINE_PERF_STAGE ${JSON.stringify({ name, uptimeMs: process.uptime() * 1000 })}`)
}

export function perfPreferences(): Electron.WebPreferences {
  return enabled ? { additionalArguments: ['--hopline-perf', ...(trace ? ['--hopline-perf-trace'] : [])] } : {}
}

export function registerPerf(win: BrowserWindow): void {
  if (!enabled) return
  let timer: NodeJS.Timeout | undefined
  const stage = (event: IpcMainEvent, name: unknown, ...extra: unknown[]) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || extra.length) return
    if (name === 'renderer-entry' || name === 'catalog-ready') perfStage(name)
  }
  const firstPaint = (event: IpcMainEvent) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return
    ipcMain.removeListener('perf:first-paint', firstPaint)
    // Reference only: process age and elapsed time since this module began executing.
    const coldStartMs = process.uptime() * 1000
    const firstPaintMs = performance.now() - startedAt
    console.log('HOPLINE_PERF_FIRST_PAINT')
    perfStage('first-paint')
    timer = setTimeout(() => {
      // Electron reports KB (1024 bytes); MB here means MiB.
      const idleMemoryMB = app.getAppMetrics().reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024
      console.log(`HOPLINE_PERF ${JSON.stringify({ coldStartMs, firstPaintMs, idleMemoryMB })}`)
      app.quit()
    }, 10_000)
  }
  ipcMain.on('perf:first-paint', firstPaint)
  if (trace) ipcMain.on('perf:stage', stage)
  win.once('closed', () => {
    clearTimeout(timer)
    ipcMain.removeListener('perf:first-paint', firstPaint)
    if (trace) ipcMain.removeListener('perf:stage', stage)
  })
}
