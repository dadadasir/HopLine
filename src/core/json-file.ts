import fs from 'node:fs'
import path from 'node:path'
import { NewerVersionError } from './vault-migrate'
import { renameReplaceSync, safeChmodSync } from './win-platform'
import type { AppInfo } from '../shared/types'

type DataNotice = NonNullable<AppInfo['dataNotices']>[number]
const dataNoticeListeners = new Set<(notice: DataNotice) => void>()

/** Subscribe during startup reads; only successfully preserved files are reported. */
export function onDataNotice(listener: (notice: DataNotice) => void): () => void {
  dataNoticeListeners.add(listener)
  return () => { dataNoticeListeners.delete(listener) }
}

function reportDataNotice(notice: DataNotice): void {
  for (const listener of dataNoticeListeners) listener(notice)
}

export type FileErrorLogger = (message: string, error?: unknown) => void

/** Only malformed contents are recoverable. I/O and quarantine failures must stop writes. */
export function readJsonFile<T>(
  filePath: string,
  decode: (value: unknown) => T,
  empty: () => T,
  logError: FileErrorLogger
): T {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    logError(`无法读取数据文件 ${filePath}`, error)
    throw error
  }
  try {
    return decode(JSON.parse(raw))
  } catch (error) {
    if (error instanceof NewerVersionError) throw error
    let preserved: string
    try {
      preserved = quarantine(filePath)
    } catch (preserveError) {
      logError(`无法保留损坏的数据文件 ${filePath}`, preserveError)
      throw new Error('无法保留损坏的数据文件，已停止读取', { cause: preserveError })
    }
    reportDataNotice({ kind: 'quarantined', path: preserved })
    logError(`数据文件损坏，已保留至 ${preserved}`, error)
    return empty()
  }
}

function quarantine(filePath: string): string {
  const { destination, fd } = reserveRecoveryFile(filePath, 'corrupt')
  fs.closeSync(fd)
  try {
    renameReplaceSync(filePath, destination)
  } catch (error) {
    fs.unlinkSync(destination)
    throw error
  }
  return destination
}

function reserveRecoveryFile(filePath: string, kind: 'corrupt' | 'rejected'): { destination: string; fd: number } {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const { dir, name, ext } = path.parse(filePath)
  for (let index = 0; ; index++) {
    const destination = path.join(dir, `${name}.${kind}-${stamp}${index ? `-${index}` : ''}${ext}`)
    // Reserve the name exclusively so rename cannot overwrite a previous recovery file.
    try {
      return { destination, fd: fs.openSync(destination, 'wx', 0o600) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
}

/** Preserve rejected raw records before callers can save the usable part of a store. */
export function writeRejectedJsonFile(filePath: string, value: unknown): string {
  const { destination, fd } = reserveRecoveryFile(filePath, 'rejected')
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    fs.unlinkSync(destination)
    throw error
  }
  reportDataNotice({ kind: 'rejected', path: destination })
  return destination
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    // mode only applies when creating a file; tighten leftover temporary files too.
    safeChmodSync(fd, 0o600)
    fs.writeFileSync(fd, JSON.stringify(value, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  renameReplaceSync(tmp, filePath)
}
