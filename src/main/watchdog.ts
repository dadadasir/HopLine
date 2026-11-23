import { app, type BrowserWindow } from 'electron'
import { logInfo, logWarn } from './logger'

const events: string[] = []
export const watchdogEvents = (): string[] => events.slice()

export function startWatchdog(win: BrowserWindow, counts: () => { sessions: number; transfers: number }, exhausted: () => void) {
  const wc = win.webContents
  let sequence = 0, pending = false, missed = 0, retries = 0
  let sentAt = 0, stalledAt: number | null = null
  const record = (level: 'info' | 'warn', message: string) => {
    events.push(`${new Date().toISOString()} ${level} ${message}`)
    if (events.length > 50) events.shift()
    ;(level === 'warn' ? logWarn : logInfo)(message)
  }
  const snapshot = () => {
    const pid = wc.getOSProcessId()
    return JSON.stringify({ main: process.memoryUsage(), renderer: { pid, memory: app.getAppMetrics().find((item) => item.pid === pid)?.memory }, ...counts() })
  }
  const ping = () => {
    if (win.isDestroyed()) return
    if (pending && ++missed >= 3 && stalledAt === null) {
      stalledAt = sentAt
      record('warn', `watchdog timeout ${snapshot()}`)
    }
    if (!pending) sentAt = Date.now()
    pending = true
    try { wc.send('watchdog:ping', ++sequence) } catch { /* A crashed renderer may have no frame. */ }
  }
  const pong = (id: number) => {
    if (!pending || id !== sequence) return
    if (stalledAt !== null) record('info', `watchdog recovered durationMs=${Date.now() - stalledAt}`)
    pending = false; missed = 0; stalledAt = null
  }
  const unresponsive = () => record('warn', `renderer unresponsive ${snapshot()}`)
  const responsive = () => record('info', 'renderer responsive')
  const gone = (_event: unknown, details: Electron.RenderProcessGoneDetails) => {
    record('warn', `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
    if (details.reason === 'clean-exit') return
    if (retries++ < 3) wc.reload()
    else if (retries === 4) exhausted()
  }
  wc.on('unresponsive', unresponsive)
  wc.on('responsive', responsive)
  wc.on('render-process-gone', gone)
  const timer = setInterval(ping, 5000)
  ping()
  const stop = () => {
    clearInterval(timer)
    wc.removeListener('unresponsive', unresponsive)
    wc.removeListener('responsive', responsive)
    wc.removeListener('render-process-gone', gone)
  }
  win.once('closed', stop)
  return { pong, stop }
}
