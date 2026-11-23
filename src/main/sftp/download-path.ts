import fs from 'node:fs'
import path from 'node:path'

/** Remote names are untrusted, including when the server claims they are ordinary files. */
export function assertDownloadName(name: string, platform = process.platform): void {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name) ||
      (platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)))) {
    throw new Error('远端文件名不能安全地保存到本地')
  }
}

export function downloadTarget(root: string, names: string[], platform = process.platform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  for (const name of names) assertDownloadName(name, platform)
  const target = paths.resolve(root, ...names)
  const relative = paths.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
    throw new Error('下载路径超出了所选目录')
  }
  return target
}

/** The selected directory itself may be a user-selected alias; descendants may not be links. */
export async function downloadRoot(directory: string): Promise<string> {
  await fs.promises.mkdir(directory, { recursive: true })
  const root = await fs.promises.realpath(directory)
  if (!(await fs.promises.lstat(root)).isDirectory()) throw new Error('请选择本地目录')
  return root
}

/** Check every component, including dangling links. Never recursively mkdir through a link. */
export async function checkDownloadPath(root: string, target: string, createParents = false): Promise<void> {
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('下载路径超出了所选目录')
  }
  const names = relative.split(path.sep)
  let current = root
  const rootStat = await fs.promises.lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('下载目录已改变，请重新选择')
  for (let index = 0; index < names.length; index++) {
    current = path.join(current, names[index]!)
    const directory = index < names.length - 1
    let stat = await lstatIfExists(current)
    if (!stat && directory && createParents) {
      try { await fs.promises.mkdir(current) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      stat = await fs.promises.lstat(current)
    }
    if (!stat) return
    if (stat.isSymbolicLink()) throw new Error('下载路径包含软链接，请选择其他位置')
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('下载目标路径类型不正确')
  }
}

export async function lstatIfExists(target: string): Promise<fs.Stats | null> {
  try { return await fs.promises.lstat(target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Validate the opened descriptor before truncation, also on platforms without O_NOFOLLOW. */
export function createDownloadStream(root: string, target: string, offset: number, mode = 0o666): fs.WriteStream {
  const openFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0)
  return fs.createWriteStream(target, {
    // WriteStream's type accepts string flags; custom open uses the numeric flags below.
    flags: 'r+',
    mode,
    start: offset,
    fs: {
      open(file: fs.PathLike, _flags: string | number, mode: number, callback: (error: NodeJS.ErrnoException | null, fd: number) => void) {
        fs.open(file, openFlags, mode, (error, fd) => {
          if (error) { callback(error, fd); return }
          const validate = async () => {
            await checkDownloadPath(root, target)
            const current = await fs.promises.lstat(target)
            const opened = await new Promise<fs.Stats>((resolve, reject) => fs.fstat(fd, (error, stat) => error ? reject(error) : resolve(stat)))
            if (current.nlink !== 1 || opened.nlink !== 1) throw new Error('下载临时文件包含硬链接，请选择其他位置')
            if (!current.isFile() || !opened.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
              throw new Error('下载临时文件已改变，请重试')
            }
            if (offset === 0) await new Promise<void>((resolve, reject) => fs.ftruncate(fd, 0, (error) => error ? reject(error) : resolve()))
          }
          void validate().then(() => callback(null, fd), (error: Error) => fs.close(fd, () => callback(error, fd)))
        })
      },
      close: fs.close,
      write: fs.write,
      writev: fs.writev
    }
  })
}
