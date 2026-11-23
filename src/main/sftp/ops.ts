import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import type { SFTPWrapper } from 'ssh2'
import { resumeOffset, uploadRange } from '../../core/shell'
import { transferPartName, transferPartTarget } from '../../core/transfer'
import { renameReplaceAsync } from '../../core/win-platform'
import type { SftpEntry } from '../../shared/types'
import { checkDownloadPath, createDownloadStream, downloadRoot, lstatIfExists } from './download-path'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000

export function remoteJoin(dir: string, name: string): string {
  const base = dir === '/' ? '' : dir.replace(/\/+$/, '')
  return `${base}/${name}`.replace(/\/{2,}/g, '/') || '/'
}

export function remoteDirname(file: string): string {
  const index = file.lastIndexOf('/')
  if (index <= 0) return '/'
  return file.slice(0, index) || '/'
}

export function isRemoteDir(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR
}

interface Attrs {
  mode: number
  size: number
  mtime: number
}

export async function realpath(sftp: SFTPWrapper, target = '.'): Promise<string> {
  return call((cb) => sftp.realpath(target, cb))
}

export async function listDirectory(sftp: SFTPWrapper, dir: string): Promise<SftpEntry[]> {
  const rows = await call<Array<{ filename: string; attrs: Attrs }>>((cb) => sftp.readdir(dir, cb))
  if (rows.some((row) => typeof row.filename !== 'string' || !row.filename || /[/\0]/.test(row.filename))) {
    throw new Error('远端目录返回了不安全的文件名')
  }
  return rows
    .filter((row) => row.filename !== '.' && row.filename !== '..')
    .map((row) => ({
      name: row.filename,
      path: remoteJoin(dir, row.filename),
      isDirectory: isRemoteDir(row.attrs.mode),
      size: row.attrs.size,
      mtime: row.attrs.mtime,
      mode: row.attrs.mode
    }))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh'))
}

export async function statPath(sftp: SFTPWrapper, target: string, followLinks = true): Promise<Attrs & { isDirectory: boolean } | null> {
  try {
    const attrs = await call<Attrs>((cb) => followLinks ? sftp.stat(target, cb) : sftp.lstat(target, cb))
    return { ...attrs, isDirectory: isRemoteDir(attrs.mode) }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function mkdirp(sftp: SFTPWrapper, dir: string, confirmed?: Map<string, Promise<void>>): Promise<void> {
  if (!dir || dir === '/' || dir === '.') return
  const abs = dir.startsWith('/')
  const parts = dir.split('/').filter(Boolean)
  let current = abs ? '' : '.'
  for (const part of parts) {
    current = current === '' ? `/${part}` : remoteJoin(current, part)
    let pending = confirmed?.get(current)
    if (!pending) {
      const target = current
      pending = ensureDirectory(sftp, target).catch((error: unknown) => {
        confirmed?.delete(target)
        throw error
      })
      confirmed?.set(target, pending)
    }
    await pending
  }
}

async function ensureDirectory(sftp: SFTPWrapper, dir: string): Promise<void> {
  const existing = await statPath(sftp, dir)
  if (existing?.isDirectory) return
  if (existing) throw new Error(`远程路径不是目录: ${dir}`)
  try {
    await call((cb) => sftp.mkdir(dir, cb))
  } catch (error) {
    const again = await statPath(sftp, dir)
    if (!again?.isDirectory) throw error
  }
}

export async function renamePath(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  await call((cb) => sftp.rename(from, to, cb))
}

export async function removePath(sftp: SFTPWrapper, target: string): Promise<void> {
  // A link is the selected entry, never permission to recurse into its target.
  if (target !== '/') target = target.replace(/\/+$/, '') || '/'
  const stat = await statPath(sftp, target, false)
  if (!stat) return
  if (stat.isDirectory) {
    const children = await listDirectory(sftp, target)
    for (const child of children) await removePath(sftp, child.path)
    await call((cb) => sftp.rmdir(target, cb))
    return
  }
  await call((cb) => sftp.unlink(target, cb))
}

export interface TransferHooks {
  signal: AbortSignal
  onProgress: (loaded: number, total: number) => void
}

type PartIndex = Map<string, Set<string>>
/** Shared by one batch, including concurrent tasks. Each directory is scanned once. */
export class TransferCleanup {
  readonly parts = new Map<string, Promise<PartIndex>>()
  readonly directories = new Map<string, Promise<void>>()
}

export async function uploadFile(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  hooks: TransferHooks,
  cleanup = new TransferCleanup()
): Promise<void> {
  hooks.signal.throwIfAborted()
  const local = await fs.promises.stat(localPath)
  const dir = remoteDirname(remotePath)
  const name = path.posix.basename(remotePath)
  const partName = transferPartName(name, local.size, local.mtimeMs)
  const partPath = remoteJoin(dir, partName)
  await mkdirp(sftp, dir, cleanup.directories)
  const index = await partIndex(cleanup, `remote:${dir}`, async () => {
    const entries = await call<Array<{ filename: string; attrs: Attrs }>>((cb) => sftp.readdir(dir, cb))
    return entries.filter((entry) => !isRemoteDir(entry.attrs.mode)).map((entry) => entry.filename)
  })
  await cleanParts(index, name, partName, async (old) => {
    try {
      await call((cb) => sftp.unlink(remoteJoin(dir, old), cb))
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  })
  const part = await statPath(sftp, partPath)
  if (part?.isDirectory) throw new Error('传输临时路径不是文件')
  const plan = uploadRange(part?.size ?? null, local.size)
  hooks.signal.throwIfAborted()
  if (!plan.done) {
    // Repair parts left read-only by earlier versions before opening with r+.
    if (part) await call((cb) => sftp.chmod(partPath, 0o600, cb))
    await pipeFile({
      source: fs.createReadStream(localPath, { start: plan.offset }),
      destination: sftp.createWriteStream(partPath, {
        flags: plan.offset > 0 ? 'r+' : 'w',
        start: plan.offset,
        mode: 0o600
      }),
      offset: plan.offset,
      total: local.size,
      ...hooks
    })
  }
  hooks.signal.throwIfAborted()
  const mode = process.platform === 'win32' ? 0o644 : local.mode & 0o777
  await call((cb) => sftp.chmod(partPath, mode, cb))
  hooks.signal.throwIfAborted()
  await replaceRemote(sftp, partPath, remotePath)
  hooks.onProgress(local.size, local.size)
}

/** Editing must preserve the target inode, owner, permissions and symlink. */
export async function overwriteFile(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  hooks: TransferHooks,
  content?: Buffer
): Promise<void> {
  hooks.signal.throwIfAborted()
  const local = await fs.promises.stat(localPath)
  hooks.signal.throwIfAborted()
  // Supplying an open handle avoids ssh2 WriteStream.open() applying fchmod.
  const handle = await call<Buffer>((cb) => sftp.open(remotePath, 'w', cb))
  await pipeFile({
    source: content ? Readable.from(content) : fs.createReadStream(localPath),
    destination: sftp.createWriteStream(remotePath, {
      handle,
      flags: 'w',
      start: 0
    }),
    offset: 0,
    total: content?.length ?? local.size,
    ...hooks
  })
}

export async function downloadFile(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  hooks: TransferHooks,
  cleanup = new TransferCleanup(),
  root?: string
): Promise<void> {
  hooks.signal.throwIfAborted()
  const remote = await statPath(sftp, remotePath)
  if (!remote || remote.isDirectory) throw new Error('远程文件不存在')
  const selectedRoot = root ?? await downloadRoot(path.dirname(localPath))
  // macOS /var and /tmp are aliases; standalone callers must use the same canonical root.
  if (!root) localPath = path.join(selectedRoot, path.basename(localPath))
  const dir = path.dirname(localPath)
  const name = path.basename(localPath)
  const partName = transferPartName(name, remote.size, remote.mtime)
  const partPath = path.join(dir, partName)
  await checkDownloadPath(selectedRoot, localPath, true)
  await checkDownloadPath(selectedRoot, partPath)
  const index = await partIndex(cleanup, `local:${dir}`, async () => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name)
  })
  await cleanParts(index, name, partName, async (old) => {
    await checkDownloadPath(selectedRoot, path.join(dir, old))
    try {
      await fs.promises.unlink(path.join(dir, old))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  })
  const part = await lstatIfExists(partPath)
  if (part && !part.isFile()) throw new Error('传输临时路径不是普通文件')
  if (part && part.nlink !== 1) throw new Error('下载临时文件包含硬链接，请选择其他位置')
  const plan = resumeOffset(part?.size ?? null, remote.size)
  hooks.signal.throwIfAborted()
  if (!plan.done) {
    await checkDownloadPath(selectedRoot, partPath)
    await pipeFile({
      keepOnAbort: true,
      source: sftp.createReadStream(remotePath, { start: plan.offset }),
      destination: createDownloadStream(selectedRoot, partPath, plan.offset),
      offset: plan.offset,
      total: remote.size,
      ...hooks
    })
  }
  hooks.signal.throwIfAborted()
  await checkDownloadPath(selectedRoot, localPath)
  await checkDownloadPath(selectedRoot, partPath)
  await renameReplaceAsync(partPath, localPath)
  hooks.onProgress(remote.size, remote.size)
}

async function partIndex(cleanup: TransferCleanup, dir: string, list: () => Promise<string[]>): Promise<PartIndex> {
  const existing = cleanup.parts.get(dir)
  if (existing) return existing
  const pending = list().then((names) => {
    const index: PartIndex = new Map()
    for (const name of names) {
      const target = transferPartTarget(name)
      if (target === null) continue
      const parts = index.get(target) ?? new Set<string>()
      parts.add(name)
      index.set(target, parts)
    }
    return index
  }).catch((error: unknown) => {
    // A failed scan must not poison later tasks after a reconnect.
    if (cleanup.parts.get(dir) === pending) cleanup.parts.delete(dir)
    throw error
  })
  cleanup.parts.set(dir, pending)
  return pending
}

async function cleanParts(index: PartIndex, target: string, current: string, remove: (name: string) => Promise<void>): Promise<void> {
  const parts = index.get(target) ?? new Set<string>()
  index.set(target, parts)
  for (const part of parts) {
    if (part === current) continue
    await remove(part)
    parts.delete(part)
  }
  // Also track parts created by this batch for later retries of the same name.
  parts.add(current)
}

/** Remote edit caches are always refreshed in full, without resumable parts. */
export async function downloadFileFresh(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  hooks: TransferHooks,
  maxBytes?: number
): Promise<void> {
  hooks.signal.throwIfAborted()
  const remote = await statPath(sftp, remotePath)
  if (!remote || remote.isDirectory) throw new Error('远程文件不存在')
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 })
  hooks.signal.throwIfAborted()
  await pipeFile({
    source: sftp.createReadStream(remotePath),
    destination: fs.createWriteStream(localPath, { flags: 'w', mode: 0o600 }),
    offset: 0,
    total: remote.size,
    maxBytes,
    ...hooks
  })
}

async function replaceRemote(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  try {
    await call((cb) => sftp.ext_openssh_rename(from, to, cb))
    return
  } catch (error) {
    // Only an unsupported extension permits the non-atomic fallback.
    const unsupported = error instanceof Error &&
      (('code' in error && error.code === 8) || error.message === 'Server does not support this extended request')
    if (!unsupported) throw error
  }
  try {
    await call((cb) => sftp.unlink(to, cb))
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await renamePath(sftp, from, to)
}

export interface LocalFile {
  abs: string
  rel: string
  size: number
}

export async function walkLocal(root: string): Promise<{ rootIsDir: boolean; files: LocalFile[]; directories: string[] }> {
  const stat = await fs.promises.stat(root)
  if (!stat.isDirectory()) {
    return { rootIsDir: false, files: [{ abs: root, rel: path.basename(root), size: stat.size }], directories: [] }
  }
  const files: LocalFile[] = []
  const directories: string[] = []
  const relative = (entry: string) => path.relative(root, entry).split(path.sep).join('/')
  const visit = async (dir: string) => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        directories.push(relative(abs))
        await visit(abs)
      } else if (entry.isFile()) {
        const fileStat = await fs.promises.stat(abs)
        files.push({
          abs,
          rel: relative(abs),
          size: fileStat.size
        })
      }
    }
  }
  await visit(root)
  return { rootIsDir: true, files, directories }
}

async function pipeFile(options: {
  source: NodeJS.ReadableStream
  destination: NodeJS.WritableStream
  offset: number
  total: number
  signal: AbortSignal
  onProgress: (loaded: number, total: number) => void
  /** Resumable downloads: on cancel, stop reading but let received bytes reach the .part file. */
  keepOnAbort?: boolean
  maxBytes?: number
}): Promise<void> {
  let loaded = options.offset
  let last = 0
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (options.signal.aborted && !options.keepOnAbort) {
        callback(abortError())
        return
      }
      loaded += chunk.length
      if (options.maxBytes !== undefined && loaded > options.maxBytes) {
        callback(new Error('文件超过 20 MB，请改为下载'))
        return
      }
      const now = Date.now()
      if (now - last > 80) {
        last = now
        options.onProgress(loaded, options.total)
      }
      callback(null, chunk)
    },
    flush(callback) {
      if (!options.signal.aborted) options.onProgress(options.total, options.total)
      callback()
    }
  })
  if (options.keepOnAbort) {
    // Destroying the write stream on cancel can drop buffered bytes (under load the .part stayed empty).
    const source = options.source as Readable
    const stop = () => {
      source.unpipe(progress)
      // Bytes already received but still buffered in the source belong in the .part too.
      for (let chunk = source.read(); chunk !== null; chunk = source.read()) progress.write(chunk)
      source.destroy()
      if (!progress.writableEnded) progress.end()
    }
    options.signal.addEventListener('abort', stop, { once: true })
    // After a cancel ssh2 may still report a failed continuation read; the cancel decides the outcome.
    source.on('error', (error) => { if (!options.signal.aborted) progress.destroy(error) })
    source.pipe(progress)
    try {
      await pipeline(progress, options.destination)
    } catch (error) {
      throw options.signal.aborted ? abortError() : error
    } finally {
      options.signal.removeEventListener('abort', stop)
    }
    if (options.signal.aborted) throw abortError()
    return
  }
  try {
    await pipeline(options.source, progress, options.destination, { signal: options.signal })
  } catch (error) {
    // An in-flight SFTP error can replace pipeline's AbortError during teardown.
    throw options.signal.aborted ? abortError() : error
  }
  if (options.signal.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: number }).code === 2
}

function call<T>(fn: (cb: (error: Error | null | undefined, result?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((error, result) => {
      if (error) reject(error)
      else resolve(result as T)
    })
  })
}
