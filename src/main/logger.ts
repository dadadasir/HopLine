import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

function line(level: string, message: string): string {
  return `${new Date().toISOString()} ${level} ${message}\n`
}

export function logInfo(message: string): void {
  write('info', message)
}

export function logWarn(message: string): void {
  write('warn', message)
}

export function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : error ? String(error) : ''
  write('error', detail ? `${message}: ${detail}` : message)
}

function write(level: string, message: string): void {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'hopline.log')
    const entry = line(level, message)
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(entry) > 1024 * 1024) {
      fs.rmSync(path.join(dir, 'hopline.3.log'), { force: true })
      for (let n = 2; n >= 0; n--) {
        const from = n ? path.join(dir, `hopline.${n}.log`) : file
        if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, `hopline.${n + 1}.log`))
      }
    }
    fs.appendFileSync(file, entry)
  } catch {
    // Logging must not break a session.
  }
}
