import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Client, type SFTPWrapper } from 'ssh2'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadFile, listDirectory, removePath } from '../src/main/sftp/ops'
import { checkDownloadPath, downloadRoot, downloadTarget } from '../src/main/sftp/download-path'
import { SessionHub } from '../src/main/sessions'
import { transferPartName } from '../src/core/transfer'
import { startMiniSshd } from './support/mini-sshd.mjs'

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../src/main/logger', () => ({ logError: vi.fn(), logInfo: vi.fn() }))

const hooks = () => ({ signal: new AbortController().signal, onProgress: () => {} })
let workspace: string
beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-sftp-safety-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(workspace, { recursive: true, force: true }) })

describe('recursive deletion over loopback SFTP', () => {
  let server: Awaited<ReturnType<typeof startMiniSshd>>
  let client: Client, sftp: SFTPWrapper, serverDirectory: string
  beforeAll(async () => {
    serverDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-delete-safety-'))
    server = await startMiniSshd({ password: 'test', root: serverDirectory })
    client = new Client()
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve).once('error', reject)
      client.connect({ host: '127.0.0.1', port: server.port, username: 'hop', password: 'test' })
    })
    sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)))
  })
  afterAll(async () => { client?.end(); await server?.close(); fs.rmSync(serverDirectory, { recursive: true, force: true }) })

  it.each(['top-level', 'trailing-slash', 'nested', 'dangling', 'cycle'] as const)('removes a %s link without following it', async (kind) => {
    const caseRoot = fs.mkdtempSync(path.join(server.root, 'delete-'))
    const selected = path.join(caseRoot, 'selected'), outside = path.join(caseRoot, 'outside')
    fs.mkdirSync(selected); fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    fs.writeFileSync(path.join(selected, 'ordinary.txt'), 'remove')
    const link = path.join(selected, 'link')
    fs.symlinkSync(kind === 'dangling' ? '../missing' : kind === 'cycle' ? '.' : '../outside', link, 'dir')
    const relative = `/${path.relative(server.root, kind === 'top-level' || kind === 'trailing-slash' ? link : selected).split(path.sep).join('/')}`
    const entries = await listDirectory(sftp, `/${path.relative(server.root, selected).split(path.sep).join('/')}`)
    expect(entries.find((entry) => entry.name === 'link')?.isDirectory).toBe(false)
    await removePath(sftp, relative + (kind === 'trailing-slash' ? '/' : ''))
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(link)).toBe(false)
    if (kind === 'top-level' || kind === 'trailing-slash') expect(fs.readFileSync(path.join(selected, 'ordinary.txt'), 'utf8')).toBe('remove')
    else expect(fs.existsSync(selected)).toBe(false)
  })
})

it.each(['//', '///'])('keeps an all-slash delete target %j rooted instead of using the server default directory', async (target) => {
  const lstat = vi.fn((_target: string, callback: (error: Error) => void) => callback(Object.assign(new Error('missing'), { code: 2 })))
  await removePath({ lstat } as unknown as SFTPWrapper, target)
  expect(lstat.mock.calls[0]?.[0]).toBe('/')
})

describe('download paths from untrusted SFTP replies', () => {
  const payload = 'remote content'
  function remote(rows: string[]) {
    return {
      stat: (target: string, callback: (error: null, attrs: object) => void) => callback(null, { mode: target === '/download' ? 0o40755 : 0o100644, size: payload.length, mtime: 1 }),
      readdir: (_target: string, callback: (error: null, rows: object[]) => void) => callback(null, rows.map((filename) => ({ filename, attrs: { mode: 0o100644, size: payload.length, mtime: 1 } }))),
      createReadStream: vi.fn(() => Readable.from([payload]))
    } as unknown as SFTPWrapper
  }
  function controlledHub(sftp: SFTPWrapper) {
    const jobs: { localPath: string; run: (options: ReturnType<typeof hooks>) => Promise<void> }[] = []
    const hub = { requireSsh: () => ({ id: 'fixture' }), sftpOf: async () => sftp,
      enqueue: (_session: unknown, job: typeof jobs[number]) => jobs.push(job) }
    return { jobs, download: (target: string, directory: string) => SessionHub.prototype.download.call(hub as unknown as SessionHub, 'fixture', target, directory) }
  }

  it.each(['../../outside.txt', '/absolute', 'nested/file', '..\\..\\outside.txt', 'C:\\outside.txt', '\0bad'])('rejects unsafe filename %j before queueing writes', async (name) => {
    const chosen = path.join(workspace, 'chosen'), outside = path.join(workspace, 'outside.txt')
    fs.mkdirSync(chosen); fs.writeFileSync(outside, 'keep')
    const { download, jobs } = controlledHub(remote(['ordinary.txt', name]))
    await expect(download('/download', chosen)).rejects.toThrow(/文件名/)
    expect(jobs).toEqual([])
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep')
    expect(fs.readdirSync(chosen)).toEqual([])
  })

  it('keeps ordinary Unicode and dot-prefixed names within the selected directory', async () => {
    const chosen = await downloadRoot(path.join(workspace, 'chosen'))
    const { download, jobs } = controlledHub(remote(['笔记.txt', '.config']))
    await download('/download', chosen)
    for (const job of jobs) await job.run(hooks())
    expect(fs.readFileSync(path.join(chosen, 'download', '笔记.txt'), 'utf8')).toBe(payload)
    expect(fs.readFileSync(path.join(chosen, 'download', '.config'), 'utf8')).toBe(payload)
  })

  it.each(['directory', 'target', 'dangling-target', 'partial'] as const)('refuses an existing local %s symlink and preserves the outside target', async (kind) => {
    const chosen = await downloadRoot(path.join(workspace, 'chosen'))
    const outside = path.join(workspace, 'outside')
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'payload.txt'), 'keep')
    const local = path.join(chosen, 'download', 'payload.txt')
    if (kind === 'directory') fs.symlinkSync(outside, path.dirname(local), 'dir')
    else {
      fs.mkdirSync(path.dirname(local))
      const link = kind === 'partial' ? path.join(path.dirname(local), transferPartName('payload.txt', payload.length, 1)) : local
      fs.symlinkSync(kind === 'dangling-target' ? path.join(outside, 'missing') : path.join(outside, 'payload.txt'), link)
    }
    const { download, jobs } = controlledHub(remote(['payload.txt']))
    if (kind === 'partial') {
      await download('/download', chosen)
      await expect(jobs[0]!.run(hooks())).rejects.toThrow(/软链接/)
    } else {
      await expect(download('/download', chosen)).rejects.toThrow(/软链接/)
      expect(jobs).toEqual([])
    }
    expect(fs.readFileSync(path.join(outside, 'payload.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(path.join(outside, 'missing'))).toBe(false)
  })

  it('rechecks queued downloads after a parent is replaced with a symlink', async () => {
    const chosen = await downloadRoot(path.join(workspace, 'chosen')), outside = path.join(workspace, 'outside')
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'payload.txt'), 'keep')
    const sftp = remote(['payload.txt']), { download, jobs } = controlledHub(sftp)
    await download('/download', chosen)
    fs.symlinkSync(outside, path.join(chosen, 'download'), 'dir')
    await expect(jobs[0]!.run(hooks())).rejects.toThrow(/软链接/)
    expect(sftp.createReadStream).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(outside, 'payload.txt'), 'utf8')).toBe('keep')
  })

  it('refuses a symlink installed at the partial-file open boundary', async () => {
    const chosen = await downloadRoot(path.join(workspace, 'chosen')), outside = path.join(workspace, 'outside.txt')
    fs.writeFileSync(outside, 'keep')
    const local = path.join(chosen, 'payload.txt'), part = path.join(chosen, transferPartName('payload.txt', payload.length, 1))
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (String(file) === part && !fs.existsSync(part)) fs.symlinkSync(outside, part)
      return (open as (...values: unknown[]) => void)(file, ...args)
    }) as typeof fs.open)
    await expect(downloadFile(remote([]), '/payload.txt', local, hooks(), undefined, chosen)).rejects.toThrow()
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep')
  })

  it.each(['existing', 'at-open'] as const)('refuses an %s partial-file hard link without truncating outside data', async (when) => {
    const chosen = await downloadRoot(path.join(workspace, 'chosen')), outside = path.join(workspace, 'outside.txt')
    fs.writeFileSync(outside, 'keep')
    const local = path.join(chosen, 'payload.txt'), part = path.join(chosen, transferPartName('payload.txt', payload.length, 1))
    if (when === 'existing') fs.linkSync(outside, part)
    else {
      const open = fs.open
      vi.spyOn(fs, 'open').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
        if (String(file) === part && !fs.existsSync(part)) fs.linkSync(outside, part)
        return (open as (...values: unknown[]) => void)(file, ...args)
      }) as typeof fs.open)
    }
    await expect(downloadFile(remote([]), '/payload.txt', local, hooks(), undefined, chosen)).rejects.toThrow('硬链接')
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep')
    expect(fs.existsSync(local)).toBe(false)
  })
})

describe('cross-platform download containment', () => {
  it.each(['..', '.', '', 'a/b', 'a\\b', 'C:\\escape', '\\server\\share', '\0bad'])('refuses unsafe component %j on both platforms', (name) => {
    expect(() => downloadTarget('/chosen', [name], 'darwin')).toThrow()
    expect(() => downloadTarget('C:\\chosen', [name], 'win32')).toThrow()
  })
  it.each(['name:stream', 'CON', 'nul.txt', 'COM1', 'LPT9.log', 'CONIN$', 'CONOUT$', 'COM¹.txt', 'LPT²', 'COM³', 'name.', 'name ', 'a?b', 'a\x01b'])('refuses Windows alias or device filename %j', (name) => {
    expect(() => downloadTarget('C:\\chosen', [name], 'win32')).toThrow()
  })
  it('supports a normal nested Windows path and rejects targets outside a real local root', async () => {
    expect(downloadTarget('C:\\chosen', ['目录', 'note.txt'], 'win32')).toBe('C:\\chosen\\目录\\note.txt')
    const root = await downloadRoot(path.join(workspace, 'chosen'))
    await expect(checkDownloadPath(root, path.join(workspace, 'outside.txt'), true)).rejects.toThrow('下载路径超出了所选目录')
  })
})
