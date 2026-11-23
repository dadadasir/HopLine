import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Client, type SFTPWrapper } from 'ssh2'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { downloadFile, downloadFileFresh, uploadFile } from '../src/main/sftp/ops'
import { isTransferPart, sameRemoteVersion, transferPartName } from '../src/core/transfer'
import { startMiniSshd } from './support/mini-sshd.mjs'

describe('SFTP transfer semantics', () => {
  let server: Awaited<ReturnType<typeof startMiniSshd>>
  let client: Client
  let sftp: SFTPWrapper
  let workspace: string
  let local: string
  let remote: string
  let remoteFile: string
  let sequence = 0
  let onRead: (operation: { path: string; offset: number; length: number }) => void = () => {}
  let onWrite: typeof onRead = () => {}

  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-transfer-'))
    server = await startMiniSshd({ password: 'test', root: path.join(workspace, 'server'),
      onRead: (operation) => onRead(operation), onWrite: (operation) => onWrite(operation) })
    client = new Client()
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve).once('error', reject)
      client.connect({ host: '127.0.0.1', port: server.port, username: 'hop', password: 'test' })
    })
    sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, opened) => error ? reject(error) : resolve(opened))
    })
  })

  beforeEach(() => {
    onRead = () => {}
    onWrite = () => {}
    const name = `case-${++sequence}`
    fs.mkdirSync(path.join(workspace, name))
    fs.mkdirSync(path.join(server.root, name))
    local = path.join(workspace, name, 'payload.bin')
    remote = `/${name}/payload.bin`
    remoteFile = path.join(server.root, remote)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    client?.end()
    await server?.close()
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it.each(['xxxxxx', 'xx'])('overwrites an unrelated upload target (%s)', async (old) => {
    fs.writeFileSync(local, 'abcdef')
    fs.writeFileSync(remoteFile, old)
    await uploadFile(sftp, local, remote, hooks())
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('abcdef')
  })

  it.each(['xxxxxx', 'xx'])('overwrites an unrelated download target (%s)', async (old) => {
    fs.writeFileSync(remoteFile, 'abcdef')
    fs.writeFileSync(local, old)
    await downloadFile(sftp, remote, local, hooks())
    expect(fs.readFileSync(local, 'utf8')).toBe('abcdef')
  })

  it('bounds fresh edit downloads by actual bytes and leaves the remote file intact', async () => {
    fs.writeFileSync(remoteFile, 'over-limit')
    await expect(downloadFileFresh(sftp, remote, local, hooks(), 4)).rejects.toThrow('文件超过 20 MB')
    expect(fs.statSync(local).size).toBeLessThanOrEqual(4)
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('over-limit')
  })

  it.each(['upload', 'download'] as const)('resumes a cancelled %s from its part file', async (direction) => {
    const upload = direction === 'upload'
    const source = upload ? local : remoteFile
    const target = upload ? remoteFile : local
    const content = Buffer.alloc(1024 * 1024, 0x73)
    fs.writeFileSync(source, content)
    fs.writeFileSync(target, 'previous target')
    const controller = new AbortController()
    const cancel = ({ offset }: { offset: number }) => { if (offset >= 128 * 1024) controller.abort() }
    if (upload) onWrite = cancel
    else onRead = cancel
    const transfer = () => upload ? uploadFile(sftp, local, remote, hooks()) : downloadFile(sftp, remote, local, hooks())
    const cancelled = upload
      ? uploadFile(sftp, local, remote, { ...hooks(), signal: controller.signal })
      : downloadFile(sftp, remote, local, { ...hooks(), signal: controller.signal })
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const part = parts(target)[0]!
    expect(part).toBeDefined()
    const offset = fs.statSync(part).size
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThan(content.length)
    expect(fs.readFileSync(target, 'utf8')).toBe('previous target')
    const offsets: number[] = []
    if (upload) onWrite = (operation) => offsets.push(operation.offset)
    else onRead = (operation) => offsets.push(operation.offset)
    await transfer()
    expect(offsets[0]).toBe(offset)
    expect(fs.readFileSync(target)).toEqual(content)
    expect(parts(target)).toEqual([])
  })

  it.each(['upload', 'download'] as const)('discards an obsolete %s part after the source changes', async (direction) => {
    const upload = direction === 'upload'
    const source = upload ? local : remoteFile
    const target = upload ? remoteFile : local
    fs.writeFileSync(source, 'old content')
    const stat = fs.statSync(source)
    const oldPart = path.join(path.dirname(target), transferPartName('payload.bin', stat.size,
      upload ? stat.mtimeMs : Math.floor(stat.mtimeMs / 1000)))
    fs.writeFileSync(oldPart, 'old ')
    // Keep the size identical: mtime must be part of the identity too.
    fs.writeFileSync(source, 'new content')
    fs.utimesSync(source, new Date(), new Date(stat.mtimeMs + 5000))
    const offsets: number[] = []
    if (upload) onWrite = (operation) => offsets.push(operation.offset)
    else onRead = (operation) => offsets.push(operation.offset)
    if (upload) await uploadFile(sftp, local, remote, hooks())
    else await downloadFile(sftp, remote, local, hooks())
    expect(offsets[0]).toBe(0)
    expect(fs.readFileSync(target, 'utf8')).toBe('new content')
    expect(parts(target)).toEqual([])
  })

  it.each(['upload', 'download'] as const)('restarts oversized %s parts and publishes complete parts', async (direction) => {
    const upload = direction === 'upload'
    const source = upload ? local : remoteFile
    const target = upload ? remoteFile : local
    fs.writeFileSync(source, 'abc')
    const stat = fs.statSync(source)
    const part = path.join(path.dirname(target), transferPartName('payload.bin', stat.size,
      upload ? stat.mtimeMs : Math.floor(stat.mtimeMs / 1000)))
    fs.writeFileSync(part, 'oversized')
    const transfer = () => upload ? uploadFile(sftp, local, remote, hooks()) : downloadFile(sftp, remote, local, hooks())
    await transfer()
    expect(fs.readFileSync(target, 'utf8')).toBe('abc')
    fs.writeFileSync(part, 'abc')
    fs.writeFileSync(target, 'old')
    const read = vi.spyOn(sftp, upload ? 'createWriteStream' : 'createReadStream')
    await transfer()
    expect(read).not.toHaveBeenCalled()
    expect(fs.readFileSync(target, 'utf8')).toBe('abc')
    expect(parts(target)).toEqual([])
  })

  it.each(['upload', 'download'] as const)('creates and replaces empty files on %s', async (direction) => {
    const upload = direction === 'upload'
    const source = upload ? local : remoteFile
    const target = upload ? remoteFile : local
    fs.writeFileSync(source, '')
    const transfer = () => upload ? uploadFile(sftp, local, remote, hooks()) : downloadFile(sftp, remote, local, hooks())
    await transfer()
    expect(fs.statSync(target).size).toBe(0)
    fs.writeFileSync(target, 'not empty')
    await transfer()
    expect(fs.statSync(target).size).toBe(0)
    expect(parts(target)).toEqual([])
  })

  it.each([0o600, 0o444])('applies local permissions to a resumed upload (part mode %s)', async (mode) => {
    fs.writeFileSync(local, 'abcdef')
    fs.chmodSync(local, 0o750)
    const stat = fs.statSync(local)
    const part = path.join(path.dirname(remoteFile), transferPartName('payload.bin', stat.size, stat.mtimeMs))
    fs.writeFileSync(part, 'abc', { mode })
    await uploadFile(sftp, local, remote, hooks())
    expect(fs.statSync(remoteFile).mode & 0o777).toBe(0o750)
  })

  it('uploads Windows files reporting mode 0100666 with remote mode 0644', async () => {
    fs.writeFileSync(local, 'content')
    const stat = fs.statSync(local)
    vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce(Object.assign(stat, { mode: 0o100666 }))
    const chmod = vi.spyOn(sftp, 'chmod')
    const nativePlatform = process.platform
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'win32' } }))
    await uploadFile(sftp, local, remote, hooks())
    expect(chmod).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(transferPartName('payload.bin', stat.size, stat.mtimeMs)), 0o644, expect.any(Function))
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('content')
    if (nativePlatform !== 'win32') expect(fs.statSync(remoteFile).mode & 0o777).toBe(0o644)
  })

  it('resumes a cancelled read-only upload and restores final permissions', async () => {
    const content = Buffer.alloc(1024 * 1024, 0x71)
    fs.writeFileSync(local, content, { mode: 0o444 })
    const controller = new AbortController()
    onWrite = ({ offset }) => { if (offset >= 128 * 1024) controller.abort() }
    await expect(uploadFile(sftp, local, remote, { ...hooks(), signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    const part = parts(remoteFile)[0]!
    expect(fs.statSync(part).mode & 0o777).toBe(0o600)
    const offset = fs.statSync(part).size
    const offsets: number[] = []
    onWrite = (operation) => offsets.push(operation.offset)
    await uploadFile(sftp, local, remote, hooks())
    expect(offsets[0]).toBe(offset)
    expect(fs.readFileSync(remoteFile)).toEqual(content)
    expect(fs.statSync(remoteFile).mode & 0o777).toBe(0o444)
    expect(parts(remoteFile)).toEqual([])
  })

  it('uses posix-rename when supported without unlinking the target', async () => {
    // ssh2's test server sends a fixed extension-free VERSION packet. Enable
    // the implemented extension on this client to exercise the real wire call.
    const extensions = (sftp as SFTPWrapper & { _extensions: Record<string, string> })._extensions
    extensions['posix-rename@openssh.com'] = '1'
    try {
      fs.writeFileSync(local, 'new')
      fs.writeFileSync(remoteFile, 'old')
      const unlink = vi.spyOn(sftp, 'unlink')
      await uploadFile(sftp, local, remote, hooks())
      expect(unlink).not.toHaveBeenCalled()
      expect(fs.readFileSync(remoteFile, 'utf8')).toBe('new')
    } finally {
      delete extensions['posix-rename@openssh.com']
    }
  })

  it('preserves the target and completed part on a rename permission failure', async () => {
    fs.writeFileSync(local, 'new')
    fs.writeFileSync(remoteFile, 'old')
    const rename = vi.spyOn(sftp, 'ext_openssh_rename').mockImplementation((_from, _to, cb) => {
      cb(Object.assign(new Error('Permission denied'), { code: 3 }))
    })
    await expect(uploadFile(sftp, local, remote, hooks())).rejects.toThrow('Permission denied')
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('old')
    expect(fs.readFileSync(parts(remoteFile)[0]!, 'utf8')).toBe('new')
    rename.mockRestore()
    await uploadFile(sftp, local, remote, hooks())
    expect(fs.readFileSync(remoteFile, 'utf8')).toBe('new')
    expect(parts(remoteFile)).toEqual([])
  })

  it('keeps a downloaded part when publishing fails and retries it', async () => {
    fs.writeFileSync(remoteFile, 'new')
    fs.writeFileSync(local, 'old')
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }))
    await expect(downloadFile(sftp, remote, local, hooks())).rejects.toThrow('Permission denied')
    expect(fs.readFileSync(local, 'utf8')).toBe('old')
    expect(fs.readFileSync(parts(local)[0]!, 'utf8')).toBe('new')
    rename.mockRestore()
    await downloadFile(sftp, remote, local, hooks())
    expect(fs.readFileSync(local, 'utf8')).toBe('new')
    expect(parts(local)).toEqual([])
  })
})

it.each(['download', 'upload'] as const)(
  'reports AbortError and resumes a cancelled %s when continuation fails before CLOSE completes',
  async (direction) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-close-race-'))
    const controller = new AbortController()
    let releaseClose!: () => void
    const continuationFailed = new Promise<void>((resolve) => { releaseClose = resolve })
    let server: Awaited<ReturnType<typeof startMiniSshd>> | undefined
    const client = new Client()
    onTestFinished(async () => {
      releaseClose()
      vi.restoreAllMocks()
      client.end()
      await server?.close()
      fs.rmSync(workspace, { recursive: true, force: true })
    })

    const upload = direction === 'upload'
    const offsets: number[] = []
    let cancelling = true
    let pendingEnd = 0
    const onOperation = ({ offset, length }: { offset: number; length: number }) => {
      offsets.push(offset)
      // Cancel a non-final protocol fragment so a continuation is guaranteed,
      // even if ssh2 reuses a partially consumed read buffer from another test.
      if (cancelling && offset >= 128 * 1024 && offset + length < pendingEnd) controller.abort()
    }
    server = await startMiniSshd({
      password: 'test',
      root: path.join(workspace, 'server'),
      onRead: upload ? undefined : onOperation,
      onWrite: upload ? onOperation : undefined,
      // Only hold the cancelled transfer's file CLOSE. Directory CLOSEs and
      // the successful retry must retain their normal behavior.
      beforeFileCloseReply: () => controller.signal.aborted && cancelling
        ? continuationFailed : Promise.resolve()
    })
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve).once('error', reject)
      client.connect({ host: '127.0.0.1', port: server!.port, username: 'hop', password: 'test' })
    })
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, opened) => error ? reject(error) : resolve(opened))
    })
    const local = path.join(workspace, 'payload.bin')
    const remote = '/payload.bin'
    const remoteFile = path.join(server.root, 'payload.bin')
    const source = upload ? local : remoteFile
    const target = upload ? remoteFile : local
    const content = Buffer.alloc(1024 * 1024, 0x73)
    fs.writeFileSync(source, content)
    fs.writeFileSync(target, 'previous target')

    const events: string[] = []
    const failures: Error[] = []
    let closed!: () => void
    const closeReplied = new Promise<void>((resolve) => { closed = resolve })
    const close = sftp.close.bind(sftp)
    vi.spyOn(sftp, 'close').mockImplementation((handle, callback) => {
      close(handle, (error) => {
        if (controller.signal.aborted) {
          events.push('close reply')
          closed()
        }
        callback(error)
      })
    })
    const failed = (error: Error | undefined | null) => {
      if (!controller.signal.aborted || !error) return
      failures.push(error)
      events.push('continuation failure')
      releaseClose()
    }
    if (upload) {
      const write = sftp.write.bind(sftp)
      vi.spyOn(sftp, 'write').mockImplementation((handle, buffer, offset, length, position, callback) => {
        pendingEnd = position + length
        write(handle, buffer, offset, length, position, (...args) => {
          callback(...args)
          failed(args[0])
        })
      })
    } else {
      const read = sftp.read.bind(sftp)
      vi.spyOn(sftp, 'read').mockImplementation((handle, buffer, offset, length, position, callback) => {
        pendingEnd = position + length
        read(handle, buffer, offset, length, position, (error, bytesRead, data, pos) => {
          callback(error, bytesRead, data, pos)
          failed(error)
        })
      })
    }

    const transfer = (signal: AbortSignal) => upload
      ? uploadFile(sftp, local, remote, { ...hooks(), signal })
      : downloadFile(sftp, remote, local, { ...hooks(), signal })
    await expect(transfer(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await closeReplied
    expect(failures.length).toBeGreaterThan(0)
    for (const error of failures) expect(error).toMatchObject({ message: 'Failure', code: 4 })
    expect(events[0]).toBe('continuation failure')
    expect(events).toContain('close reply')
    const remaining = parts(target)
    expect(remaining).toHaveLength(1)
    const offset = fs.statSync(remaining[0]!).size
    expect(offset).toBeGreaterThan(0)
    expect(offset).toBeLessThan(content.length)
    expect(fs.readFileSync(target, 'utf8')).toBe('previous target')

    cancelling = false
    offsets.length = 0
    await transfer(new AbortController().signal)
    expect(offsets[0]).toBe(offset)
    expect(fs.readFileSync(target)).toEqual(content)
    expect(parts(target)).toEqual([])
  }
)

it('keeps bytes already received when a download is cancelled before the .part file is open', async () => {
  // Pin the slow-disk case: fs.open is delayed, so every received byte is still buffered when the user cancels.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-slow-disk-'))
  const target = path.join(workspace, 'payload.bin')
  const controller = new AbortController()
  const chunk = Buffer.alloc(64 * 1024, 0x61)
  let reads = 0
  // Two chunks arrive together; the second is still buffered in the source when the user cancels.
  const source = new Readable({
    read() {
      if (reads++ === 0) { this.push(chunk); this.push(chunk) } else controller.abort()
    }
  })
  const sftp = {
    stat: (_path: string, callback: (error: null, attrs: object) => void) => {
      callback(null, { mode: 0o100600, size: 1024 * 1024, mtime: 1 })
    },
    createReadStream: () => source
  } as unknown as SFTPWrapper
  const open = fs.open
  vi.spyOn(fs, 'open').mockImplementation(((...args: unknown[]) => {
    const callback = args.pop() as (...result: unknown[]) => void
    setTimeout(() => (open as (...a: unknown[]) => void)(...args, callback), 200)
  }) as typeof fs.open)
  try {
    await expect(downloadFile(sftp, '/payload.bin', target, { ...hooks(), signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    vi.restoreAllMocks()
    const part = parts(target)[0]!
    expect(fs.statSync(part).size).toBe(2 * chunk.length)
    expect(fs.existsSync(target)).toBe(false)
  } finally {
    vi.restoreAllMocks()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

it.each([
  { name: 'preserves the original source error when the download signal is not aborted', cancel: false },
  { name: 'reports AbortError when a source error follows download cancellation', cancel: true }
])('$name', async ({ cancel }) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-source-error-'))
  const target = path.join(workspace, 'payload.bin')
  const error = new Error('source read failed')
  const controller = new AbortController()
  const source = new Readable({
    read() {
      if (cancel) {
        controller.abort()
        // Like ssh2 ReadStream, emit the in-flight read error even after destroy.
        this.emit('error', error)
      } else this.destroy(error)
    }
  })
  const sftp = {
    stat: (_path: string, callback: (error: null, attrs: object) => void) => {
      callback(null, { mode: 0o100600, size: 1024, mtime: 1 })
    },
    createReadStream: () => source
  } as unknown as SFTPWrapper
  try {
    fs.writeFileSync(target, 'previous target')
    const transfer = downloadFile(sftp, '/payload.bin', target, { ...hooks(), signal: controller.signal })
    if (cancel) await expect(transfer).rejects.toMatchObject({ name: 'AbortError' })
    else await expect(transfer).rejects.toBe(error)
    expect(controller.signal.aborted).toBe(cancel)
    expect(error.name).toBe('Error')
    expect(fs.readFileSync(target, 'utf8')).toBe('previous target')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

it('recognizes only exact part names and compares both remote version fields', () => {
  const part = transferPartName('a.b', 100, 200)
  expect(isTransferPart('a.b', part)).toBe(true)
  expect(isTransferPart('a', part)).toBe(false)
  expect(isTransferPart('a.b', '.a.b.notes.hopline-part')).toBe(false)
  expect(transferPartName('a.b', 100, 201)).not.toBe(part)
  expect(sameRemoteVersion({ size: 1, mtime: 2 }, { size: 1, mtime: 2 })).toBe(true)
  expect(sameRemoteVersion({ size: 1, mtime: 2 }, { size: 2, mtime: 2 })).toBe(false)
  expect(sameRemoteVersion({ size: 1, mtime: 2 }, { size: 1, mtime: 3 })).toBe(false)
  expect(sameRemoteVersion({ size: 1, mtime: 2 }, null)).toBe(false)
})

function parts(target: string): string[] {
  return fs.readdirSync(path.dirname(target)).filter((name) => isTransferPart(path.basename(target), name))
    .map((name) => path.join(path.dirname(target), name))
}

function hooks() {
  return { signal: new AbortController().signal, onProgress: () => undefined }
}
