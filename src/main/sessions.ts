import type { PersistentOptions, PersistentSession } from '../shared/types'
import { ShellIntegrationStore } from './shell-integration-store'
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { renameReplaceSync, resolveAsarUnpackedModule, resolveWindowsShell, safeChmodSync } from '../core/win-platform'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import type { FSWatcher } from 'chokidar'
import { translate } from '../shared/i18n'
import { TransferQueue } from '../core/transfer-queue'
import { shellEscape, shouldPackSmallFiles } from '../core/shell'
import { Vault } from '../core/vault'
import type { SessionInfo, SessionStatus, TransferJob } from '../shared/types'
import { logError, logInfo } from './logger'
import { KnownHostFile } from './known-hosts-file'
import { assertDownloadName, checkDownloadPath, createDownloadStream, downloadRoot, downloadTarget } from './sftp/download-path'
import { editContent } from './sftp/edit-content'
import { readAtomicEdit, saveAtomicEdit } from './sftp/atomic-edit'
import { withEditNamespace } from './sftp/edit-namespace'
import { openShell, type HostCheck, type KeyboardRequest } from './ssh/connect'
import { ConnectionPool, type Lease } from './ssh/pool'
import { execOnClient } from './ssh/exec'
import {
  downloadFile,
  listDirectory,
  mkdirp,
  realpath,
  remoteDirname,
  remoteJoin,
  removePath,
  renamePath,
  statPath,
  uploadFile,
  walkLocal,
  TransferCleanup
} from './sftp/ops'

const execFileAsync = promisify(execFile)
const EDIT_MANIFEST = '.hopline-edit.json'

interface EditManifest {
  remotePath: string
  hostId: string
  savedLocal: { size: number; mtimeMs: number }
  dirty: boolean
  error?: string
  conflict?: boolean
}

interface EditWatch {
  watcher?: FSWatcher
  chain: Promise<void>
  controller: AbortController
  stopped: boolean
  localPath: string
  manifestPath: string
  dirty: boolean
  revision: number
  savedLocal?: { size: number; mtimeMs: number }
  error?: string
  conflict?: boolean
}

interface LiveSession {
  id: string
  kind: 'ssh' | 'local'
  /** Host-owned file access has no terminal and survives closing terminal tabs. */
  filesOnly?: boolean
  filesConfig?: string
  filesRetired?: boolean
  title: string
  hostId?: string
  status: SessionStatus
  message?: string
  tmuxName?: string
  tmuxMissing?: boolean
  shellHostname?: string
  retryTimer?: ReturnType<typeof setTimeout>
  lease?: Lease
  offDrop?: () => void
  attachment?: symbol
  connecting?: Set<AbortController>
  shell?: ClientChannel
  sftp?: SFTPWrapper
  sftpPromise?: Promise<SFTPWrapper>
  reconnecting?: Promise<void>
  pty?: { write(data: string): void; resize(cols: number, rows: number): void; kill(): void }
  queue: TransferQueue
  cols: number
  rows: number
  watchers: Map<string, EditWatch>
}

type Emit = (channel: string, payload: unknown) => void

export class SessionHub {
  autoStartForwards?: (hostId: string) => Promise<void>
  readonly pool: ConnectionPool
  readonly startupRecovered: string[]
  /** The watch directory left untouched because startup recovery failed. */
  readonly startupRecoveryFailed: string | null
  private sessions = new Map<string, LiveSession>()
  private filesByHost = new Map<string, string>()
  private jobs = new Map<string, TransferJob>()
  private prompts = new Map<string, { resolve: (value: boolean) => void; check?: HostCheck }>()
  private keyboards = new Map<string, (answers: string[] | null) => void>()

  constructor(
    private readonly vault: Vault,
    private readonly known: KnownHostFile,
    private readonly emit: Emit,
    private readonly userData: string
  ) {
    this.pool = new ConnectionPool(vault, {
      verifyHost: (check) => this.verifyHost(check),
      verifyHostWithoutPrompt: async (check) => this.known.judge(check.host, check.port, check.fingerprint) === 'trusted',
      onKeyboard: (request) => this.askKeyboard(request)
    })
    const startup = recoverStartupEdits(userData)
    this.startupRecovered = startup.recovered
    this.startupRecoveryFailed = startup.failed
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].filter((session) => !session.filesOnly).map(toInfo)
  }

  /** Returns an opaque id accepted by the existing SFTP/transfer operations. */
  async openHostFiles(hostId: string): Promise<string> {
    const host = this.vault.getHost(hostId)
    if (!host) throw new Error('主机不存在')
    const config = this.fileConfig(hostId)
    let session = this.sessions.get(this.filesByHost.get(hostId) ?? '')
    if (session && session.filesConfig !== config) {
      this.filesByHost.delete(hostId)
      session.filesRetired = true
      this.releaseRetiredFiles(session)
      session = undefined
    }
    if (!session) {
      session = this.create(randomUUID(), 'ssh', host.name, 80, 24, hostId)
      session.filesOnly = true
      session.filesConfig = config
      this.filesByHost.set(hostId, session.id)
    }
    await this.sftpOf(session.id)
    return session.id
  }

  /** Host deletion closes file leases as well as terminals and pending authentication. */
  async closeHost(hostId: string): Promise<void> {
    await Promise.all([...this.sessions.values()].filter((session) => session.hostId === hostId).map(async (session) => {
      await this.close(session.id)
      if (!session.filesOnly) this.emit('ssh:status', { ...toInfo(session), status: 'closed', message: '主机已删除' })
    }))
  }

  async openLocal(cols: number, rows: number): Promise<SessionInfo> {
    const pty = await loadPty()
    const locale = this.vault.snapshot().settings.language
    if (!pty) throw new Error(translate(locale, 'ptyUnavailable'))
    const shell = localShell()
    const id = randomUUID()
    const session = this.create(id, 'local', translate(locale, 'localTitle'), cols, rows)
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    const term = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: clampDim(cols),
      rows: clampDim(rows),
      cwd: os.homedir(),
      env
    })
    session.pty = term
    session.status = 'connected'
    const ownsPty = () => this.sessions.get(id) === session && session.pty === term
    term.onData((data) => {
      if (ownsPty()) this.emit('pty:data', { sessionId: id, data })
    })
    term.onExit(({ exitCode }) => {
      if (!ownsPty()) return
      session.status = 'closed'
      session.message = `进程已退出 (${exitCode})`
      this.emit('pty:exit', { sessionId: id, exitCode })
      this.emit('ssh:status', toInfo(session))
    })
    return toInfo(session)
  }

  async connect(hostId: string, cols: number, rows: number, options: PersistentOptions = {}): Promise<SessionInfo> {
    const host = this.vault.getHost(hostId)
    if (!host) throw new Error('主机不存在')
    if (options.persistent !== undefined && typeof options.persistent !== 'boolean') throw new Error('持久会话开关不合法')
    if (options.tmuxName !== undefined) requireTmuxName(options.tmuxName)
    const id = randomUUID()
    const session = this.create(id, 'ssh', host.name, cols, rows, hostId)
    if (options.tmuxName || (options.persistent ?? host.persistent)) session.tmuxName = options.tmuxName ?? `hopline-${randomUUID().slice(0, 6)}`
    session.status = 'connecting'
    try {
      await this.attachSsh(session, cols, rows)
      logInfo(`ssh connected ${host.username}@${host.host}:${host.port}`)
      return toInfo(session)
    } catch (error) {
      this.sessions.delete(id)
      throw error
    }
  }

  async reconnect(sessionId: string, cols: number, rows: number): Promise<SessionInfo> {
    const session = this.require(sessionId)
    clearTimeout(session.retryTimer)
    if (session.kind !== 'ssh' || !session.hostId || session.filesOnly) throw new Error('只有 SSH 会话可以重连')
    session.attachment = undefined
    const { shell, lease, sftp } = session
    session.offDrop?.()
    session.offDrop = undefined
    session.lease = undefined
    session.shell = undefined
    session.sftp = undefined
    session.sftpPromise = undefined
    shell?.close()
    sftp?.end()
    lease?.release()
    session.status = 'connecting'
    session.message = undefined
    this.emit('ssh:status', toInfo(session))
    const pending = this.attachSsh(session, cols, rows, true)
    session.reconnecting = pending
    try {
      await pending
    } catch (error) {
      if (session.reconnecting === pending && this.sessions.get(sessionId) === session) {
        session.status = 'error'
        session.message = error instanceof Error ? error.message : String(error)
        this.emit('ssh:status', toInfo(session))
      }
      throw error
    } finally {
      if (session.reconnecting === pending) session.reconnecting = undefined
    }
    this.emit('ssh:data', { sessionId, data: Buffer.from('\r\n\x1b[38;5;244m— 已重新连接 —\x1b[0m\r\n') })
    return toInfo(session)
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || data.length > 512 * 1024) return
    if (session.pty) session.pty.write(data)
    else session.shell?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.cols = clampDim(cols)
    session.rows = clampDim(rows)
    session.pty?.resize(session.cols, session.rows)
    session.shell?.setWindow(session.rows, session.cols, session.rows * 16, session.cols * 8)
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    clearTimeout(session.retryTimer)
    this.sessions.delete(sessionId)
    for (const controller of session.connecting ?? []) controller.abort()
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId) {
        if (job.status === 'queued' || job.status === 'running') {
          session.queue.cancel(job.id)
          // Running cancellation settles asynchronously, after this job is removed.
          // Publish it now so a global activity view cannot keep showing it as running.
          if (this.jobs.get(job.id)?.status !== 'cancelled') {
            job.status = 'cancelled'
            this.emit('transfer:event', { ...job })
          }
        }
        this.jobs.delete(job.id)
      }
    }
    const edits = [...session.watchers.entries()]
    session.watchers.clear()
    for (const [, edit] of edits) {
      edit.stopped = true
      edit.controller.abort()
    }
    await Promise.all(edits.map(([, edit]) => edit.watcher?.close().catch(() => undefined)))
    session.attachment = undefined
    const pty = session.pty
    session.pty = undefined
    pty?.kill()
    const shell = session.shell
    session.shell = undefined
    shell?.close()
    session.sftp?.end()
    session.sftp = undefined
    session.sftpPromise = undefined
    await Promise.allSettled(edits.map(([, edit]) => edit.chain))
    try {
      for (const [remotePath, edit] of edits) await this.recoverEdit(sessionId, remotePath, edit)
    } catch (error) {
      // Keep the failed close retryable after the recovery destination is fixed.
      session.watchers = new Map(edits)
      session.status = 'error'
      session.message = '未回传修改保全失败，本地副本已保留'
      this.sessions.set(sessionId, session)
      if (!session.filesOnly) this.emit('ssh:status', toInfo(session))
      throw error
    }
    await fs.promises.rm(path.join(this.userData, 'watch', sessionId), { recursive: true, force: true }).catch((error: unknown) => {
      logError('watch cache cleanup deferred', error)
    })
    session.offDrop?.()
    session.offDrop = undefined
    session.lease?.release()
    session.lease = undefined
    if (session.hostId && this.filesByHost.get(session.hostId) === sessionId) this.filesByHost.delete(session.hostId)
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) =>
      this.close(id).catch((error: unknown) => logError('session close failed', error))))
  }

  respondHostKey(requestId: string, decision: 'reject' | 'once' | 'save'): void {
    const pending = this.prompts.get(requestId)
    if (!pending) return
    this.prompts.delete(requestId)
    if (decision === 'save' && pending.check) {
      this.known.remember(pending.check.host, pending.check.port, pending.check.fingerprint)
    }
    pending.resolve(decision !== 'reject')
  }

  respondKeyboard(requestId: string, answers: string[] | null): void {
    const pending = this.keyboards.get(requestId)
    if (!pending) return
    this.keyboards.delete(requestId)
    pending(answers)
  }

  async sftpList(sessionId: string, dir?: string): Promise<{ path: string; entries: Awaited<ReturnType<typeof listDirectory>> }> {
    const sftp = await this.sftpOf(sessionId)
    try {
      const target = dir && dir.trim() ? dir : await realpath(sftp, '.')
      const resolved = dir ? target : await realpath(sftp, target)
      const entries = await listDirectory(sftp, resolved)
      return { path: resolved, entries }
    } catch (error) {
      logError(`sftp list ${dir ?? '.'}`, error)
      throw error
    }
  }

  async sftpMkdir(sessionId: string, dir: string): Promise<void> {
    await mkdirp(await this.sftpOf(sessionId), dir)
  }

  async sftpRename(sessionId: string, from: string, to: string): Promise<void> {
    await renamePath(await this.sftpOf(sessionId), from, to)
  }

  async sftpRemove(sessionId: string, target: string): Promise<void> {
    await removePath(await this.sftpOf(sessionId), target)
  }

  async upload(sessionId: string, localPaths: string[], remoteDir: string): Promise<void> {
    const session = this.requireSsh(sessionId)
    await this.sftpOf(sessionId)
    const cleanup = new TransferCleanup()
    const pack = this.vault.snapshot().settings.packSmallFiles
    for (const localPath of localPaths) {
      if (!path.isAbsolute(localPath) || localPath.includes('\0')) throw new Error('本地路径不合法')
      const stat = await fs.promises.stat(localPath)
      if (stat.isDirectory()) {
        const walked = await walkLocal(localPath)
        if (pack && shouldPackSmallFiles(walked.files)) {
          this.enqueue(session, {
            direction: 'upload',
            name: `${path.basename(localPath)}.tar.gz`,
            localPath,
            remotePath: remoteDir,
            total: walked.files.reduce((sum, file) => sum + file.size, 0),
            run: (hooks) => this.packUpload(session, localPath, remoteDir, hooks, cleanup)
          })
          continue
        }
        const base = path.basename(localPath)
        for (const file of walked.files) {
          this.enqueue(session, {
            direction: 'upload',
            name: file.rel,
            localPath: file.abs,
            remotePath: remoteJoin(remoteJoin(remoteDir, base), file.rel),
            total: file.size,
            run: async (hooks) => uploadFile(await this.sftpOf(session.id), file.abs, remoteJoin(remoteJoin(remoteDir, base), file.rel), hooks, cleanup)
          })
        }
        continue
      }
      this.enqueue(session, {
        direction: 'upload',
        name: path.basename(localPath),
        localPath,
        remotePath: remoteJoin(remoteDir, path.basename(localPath)),
        total: stat.size,
        run: async (hooks) => uploadFile(await this.sftpOf(session.id), localPath, remoteJoin(remoteDir, path.basename(localPath)), hooks, cleanup)
      })
    }
  }

  async download(sessionId: string, remotePath: string, localDir: string): Promise<void> {
    const session = this.requireSsh(sessionId)
    if (!path.isAbsolute(localDir)) throw new Error('请选择本地目录')
    const sftp = await this.sftpOf(sessionId)
    const stat = await statPath(sftp, remotePath)
    if (!stat) throw new Error('远程路径不存在')
    const root = await downloadRoot(localDir)
    const cleanup = new TransferCleanup()
    if (!stat.isDirectory) {
      const localPath = downloadTarget(root, [path.posix.basename(remotePath)])
      await checkDownloadPath(root, localPath)
      this.enqueue(session, {
        direction: 'download',
        name: path.posix.basename(remotePath),
        localPath,
        remotePath,
        total: stat.size,
        run: async (hooks) => downloadFile(await this.sftpOf(session.id), remotePath, localPath, hooks, cleanup, root)
      })
      return
    }
    const files = await walkRemote(sftp, remotePath)
    const base = path.posix.basename(remotePath)
    // Validate the entire batch before queueing any write; repeat filesystem checks when it runs.
    const planned = files.map((file) => ({ file, localPath: downloadTarget(root, [...(base ? [base] : []), ...file.rel.split('/')]) }))
    for (const { localPath } of planned) await checkDownloadPath(root, localPath)
    for (const { file, localPath } of planned) {
      this.enqueue(session, {
        direction: 'download',
        name: file.rel,
        localPath,
        remotePath: file.remote,
        total: file.size,
        run: async (hooks) => downloadFile(await this.sftpOf(session.id), file.remote, localPath, hooks, cleanup, root)
      })
    }
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    this.sessions.get(job.sessionId)?.queue.cancel(jobId)
  }

  jobsFor(sessionId?: string): TransferJob[] {
    return [...this.jobs.values()].filter((job) => sessionId === undefined || job.sessionId === sessionId)
  }

  async editRemote(sessionId: string, remotePath: string): Promise<{ localPath: string }> {
    const session = this.requireSsh(sessionId)
    const folder = path.join(
      this.userData,
      'watch',
      sessionId,
      createHash('sha1').update(remotePath).digest('hex').slice(0, 12)
    )
    const name = path.posix.basename(remotePath)
    assertDownloadName(name)
    // Keep remote files with reserved metadata names separate from the sidecar.
    const payloadDir = name === EDIT_MANIFEST || name === `${EDIT_MANIFEST}.tmp` ? path.join(folder, 'content') : folder
    const localPath = path.join(payloadDir, name)
    const previous = session.watchers.get(remotePath)
    if (previous) previous.stopped = true
    const entry: EditWatch = {
      controller: new AbortController(), chain: Promise.resolve(), stopped: false,
      localPath, manifestPath: path.join(folder, EDIT_MANIFEST), dirty: false, revision: 0
    }
    session.watchers.set(remotePath, entry)
    const { signal } = entry.controller
    entry.chain = (async () => {
      if (previous) {
        // Let any in-flight save finish before replacing the local cache.
        await previous.chain.catch(() => undefined)
        previous.controller.abort()
        await previous.watcher?.close().catch(() => undefined)
        entry.dirty = previous.dirty
        entry.savedLocal = previous.savedLocal
        entry.error = previous.error
        entry.conflict = previous.conflict
        await this.recoverEdit(sessionId, remotePath, entry)
        entry.savedLocal = undefined
      }
      signal.throwIfAborted()
      const sftp = await this.sftpOf(sessionId)
      const lease = session.lease
      if (!lease) throw new Error('连接已断开')
      const initial = await withEditNamespace(sftp, remotePath, signal,
        (target, proof) => readAtomicEdit(lease.client, target, signal, proof))
      signal.throwIfAborted()
      if (session.lease !== lease) throw new Error('会话连接已失效')
      let baseline = initial.baseline
      await fs.promises.mkdir(payloadDir, { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      await pipeline(Readable.from([initial.content]), createDownloadStream(payloadDir, localPath, 0, 0o600), { signal })
      await fs.promises.chmod(localPath, 0o600)
      const downloaded = await fs.promises.stat(localPath)
      entry.savedLocal = { size: downloaded.size, mtimeMs: downloaded.mtimeMs }
      this.persistEdit(session, remotePath, entry)
      signal.throwIfAborted()
      const { watch } = await import('chokidar')
      signal.throwIfAborted()
      const watcher = watch(localPath, {
        ignoreInitial: true,
        usePolling: true,
        interval: 1000,
        binaryInterval: 1000,
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }
      })
      entry.watcher = watcher
      const failed = (error: unknown) => {
        entry.dirty = true
        entry.error = error instanceof Error ? error.message : '回传失败'
        try {
          this.persistEdit(session, remotePath, entry)
        } catch (manifestError) {
          logError('edit manifest write failed', manifestError)
        }
        if (signal.aborted) return
        logError('edit reupload failed', error)
        this.emit('edit:synced', { sessionId, remotePath, error: entry.error })
      }
      const uploadBack = () => {
        if (signal.aborted || entry.stopped) return
        entry.dirty = true
        const revision = ++entry.revision
        try {
          this.persistEdit(session, remotePath, entry)
        } catch (error) {
          failed(error)
          return
        }
        entry.chain = entry.chain
          .then(async () => {
            signal.throwIfAborted()
            const current = await this.sftpOf(sessionId)
            // Freeze one bounded local revision before checking and writing remotely.
            const local = await fs.promises.stat(localPath)
            const payload = await editContent(fs.createReadStream(localPath), signal, true)
            const afterRead = await fs.promises.stat(localPath)
            if (local.size !== afterRead.size || local.mtimeMs !== afterRead.mtimeMs) throw new Error('本地文件正在变化，请保存后重试')
            const currentLease = session.lease
            if (!currentLease) throw new Error('连接已断开')
            try {
              const saved = await withEditNamespace(current, remotePath, signal,
                (target, proof) => saveAtomicEdit(currentLease.client, target, baseline, payload.content, signal, proof))
              if (session.lease !== currentLease) throw new Error('会话连接已失效')
              baseline = saved.baseline
            } catch (error) {
              if (error instanceof Error && error.message.includes('远端文件已被修改')) {
                entry.error = error.message
                entry.conflict = true
                this.persistEdit(session, remotePath, entry)
                this.emit('edit:synced', { sessionId, remotePath, conflict: true, error: entry.error })
                return
              }
              throw error
            }
            signal.throwIfAborted()
            entry.savedLocal = { size: local.size, mtimeMs: local.mtimeMs }
            if (revision === entry.revision) entry.dirty = false
            entry.error = undefined
            entry.conflict = undefined
            this.persistEdit(session, remotePath, entry)
            this.emit('edit:synced', { sessionId, remotePath })
          })
          .catch(failed)
      }
      watcher.on('change', uploadBack)
      watcher.on('add', uploadBack)
      await once(watcher, 'ready', { signal })
      signal.throwIfAborted()
      const { shell } = await import('electron')
      signal.throwIfAborted()
      const opened = await shell.openPath(localPath)
      if (opened && !(process.platform === 'win32' && await openWithWindowsNotepad(localPath))) {
        throw new Error(opened)
      }
    })()
    try {
      await entry.chain
      return { localPath }
    } catch (error) {
      entry.controller.abort()
      await entry.watcher?.close().catch(() => undefined)
      if (session.watchers.get(remotePath) === entry && !entry.dirty) {
        session.watchers.delete(remotePath)
        await fs.promises.rm(folder, { recursive: true, force: true })
      }
      throw error
    }
  }

  private persistEdit(session: LiveSession, remotePath: string, edit: EditWatch): void {
    if (!edit.savedLocal || !session.hostId) throw new Error('远程编辑基线尚未就绪')
    const manifest: EditManifest = {
      remotePath, hostId: session.hostId, savedLocal: edit.savedLocal,
      dirty: edit.dirty, error: edit.error, conflict: edit.conflict
    }
    const tmp = `${edit.manifestPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(manifest), { mode: 0o600 })
    safeChmodSync(tmp, 0o600)
    renameReplaceSync(tmp, edit.manifestPath)
  }

  private async recoverEdit(sessionId: string, remotePath: string, edit: EditWatch): Promise<void> {
    // Chokidar debounces changes; a close/reopen can precede its change event.
    if (!edit.dirty && edit.savedLocal) {
      const local = await fs.promises.stat(edit.localPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      edit.dirty = local !== null &&
        (local.size !== edit.savedLocal.size || local.mtimeMs !== edit.savedLocal.mtimeMs)
    }
    if (!edit.dirty) return
    try {
      const recoveredPath = recoverLocalFile(edit.localPath, path.join(this.userData, 'recovered'))
      edit.dirty = false
      edit.savedLocal = undefined
      logInfo(`edit recovered ${remotePath} -> ${recoveredPath}`)
      this.emit('edit:synced', {
        sessionId, remotePath, recoveredPath,
        error: `${edit.error ?? '修改尚未回传'}，本地修改已保留`,
        ...(edit.conflict ? { conflict: true } : {})
      })
      edit.error = undefined
      edit.conflict = undefined
    } catch (error) {
      logError(`edit recovery failed ${edit.localPath}`, error)
      this.emit('edit:synced', {
        sessionId, remotePath, error: `无法保全未回传修改，本地副本保留在 ${edit.localPath}`
      })
      // Never remove or overwrite the only local copy if recovery fails.
      throw error
    }
  }

  private async attachSsh(session: LiveSession, cols: number, rows: number, fresh = false): Promise<void> {
    const host = this.vault.getHost(session.hostId!)
    if (!host) throw new Error('主机不存在')
    const attachment = Symbol()
    session.attachment = attachment
    const controller = new AbortController()
    session.connecting ??= new Set()
    session.connecting.add(controller)
    let lease: Lease
    try {
      lease = await this.pool.acquire(host.id, { fresh, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw new Error('会话已关闭')
      throw error
    } finally {
      session.connecting.delete(controller)
    }
    const current = () => this.sessions.get(session.id) === session && session.attachment === attachment
    if (!current()) {
      lease.release()
      throw new Error('会话已关闭')
    }
    session.lease = lease
    let dropped = false
    const offDrop = lease.onDrop(() => {
      dropped = true
      if (!current() || session.lease !== lease) return
      session.status = 'closed'
      session.message = '连接已断开'
      session.lease = undefined
      session.sftp = undefined
      session.sftpPromise = undefined
      lease.release()
      this.emit('ssh:status', toInfo(session))
      if (session.tmuxName && !session.tmuxMissing) this.retryPersistent(session)
    })
    session.offDrop = offDrop
    let shell: ClientChannel
    let command: string | undefined
    try {
      command = await this.persistentCommand(session, host.startupCommand)
      if (new ShellIntegrationStore(this.userData).has(host.id)) {
        const hostname = await execOnClient(lease.client, 'hostname', { timeoutMs: 10_000, maxOutputBytes: 1024 })
        if (hostname.code === 0) session.shellHostname = hostname.stdout.trim()
        command ??= integrationShellCommand(host.startupCommand)
      }
      if (!current() || dropped) throw new Error('会话连接已失效')
      shell = await openShell(lease.client, clampDim(cols), clampDim(rows))
    } catch (error) {
      offDrop()
      if (session.lease === lease) {
        session.lease = undefined
        session.offDrop = undefined
      }
      lease.release()
      throw error
    }
    if (!current() || session.lease !== lease || dropped) {
      shell.on('error', () => {})
      shell.close()
      offDrop()
      lease.release()
      throw new Error('会话连接已失效')
    }
    session.shell = shell
    session.cols = clampDim(cols)
    session.rows = clampDim(rows)
    session.status = 'connected'
    void this.autoStartForwards?.(host.id)
    session.message = undefined
    const ownsShell = () => current() && session.lease === lease && session.shell === shell && !dropped
    shell.on('data', (data: Buffer) => {
      if (ownsShell()) this.emit('ssh:data', { sessionId: session.id, data: Buffer.from(data) })
    })
    shell.on('close', () => {
      if (!ownsShell() || session.status !== 'connected') return
      session.status = 'closed'
      session.message = '连接已断开'
      this.emit('ssh:status', toInfo(session))
    })
    shell.on('error', (error: Error) => {
      if (!ownsShell()) return
      session.status = 'error'
      session.message = error.message
      logError('ssh session error', error)
      this.emit('ssh:status', toInfo(session))
    })
    if (command) shell.write(`${command}\n`)
    else if (host.startupCommand) {
      shell.write(host.startupCommand.endsWith('\n') ? host.startupCommand : `${host.startupCommand}\n`)
    }
    this.emit('ssh:status', toInfo(session))
  }

  private retryPersistent(session: LiveSession, delay = 1000): void {
    clearTimeout(session.retryTimer)
    session.retryTimer = setTimeout(() => {
      if (this.sessions.get(session.id) !== session || session.status === 'connected') return
      if (session.reconnecting) { this.retryPersistent(session, delay); return }
      void this.reconnect(session.id, session.cols, session.rows).catch(() => {
        if (this.sessions.get(session.id) === session) this.retryPersistent(session, Math.min(delay * 2, 30_000))
      })
    }, delay)
  }

  private async persistentCommand(session: LiveSession, startup: string | null): Promise<string | undefined> {
    if (!session.tmuxName) return
    const result = await this.pool.exec(session.hostId!, 'command -v tmux', { timeoutMs: 10_000, maxOutputBytes: 4096 })
    if (result.timedOut || result.signal || result.code === null) throw new Error('无法检测 tmux')
    session.tmuxMissing = result.code !== 0 || !result.stdout.trim()
    if (session.tmuxMissing) return
    const name = shellEscape(requireTmuxName(session.tmuxName))
    // No global options: only this session and its initial window are changed.
    const integrated = new ShellIntegrationStore(this.userData).has(session.hostId!)
    return `exec tmux new-session -A -s ${name}${integrated ? ' -e HOPLINE_SHELL_INTEGRATION=1' : ''}${startup ? ` ${shellEscape(startup + '\nexec "${SHELL:-/bin/sh}" -l')}` : ''}` +
      ` \\; set-option -t ${name} set-titles on \\; set-option -t ${name} set-titles-string '#{pane_title}'` +
      ` \\; set-option -w -t ${name} allow-passthrough on`
  }

  async listPersistent(hostId: string): Promise<PersistentSession[]> {
    const result = await this.pool.exec(hostId, "tmux ls -F '#{session_name} #{session_activity} #{session_attached}'", { maxOutputBytes: 64 * 1024 })
    if (result.code !== 0) throw new Error(result.stderr.trim() || '无法列出持久会话')
    return result.stdout.split('\n').flatMap((line) => {
      const [name, activity, attached] = line.trim().split(/\s+/)
      return /^hopline-[a-zA-Z0-9]{6}$/.test(name) && /^\d+$/.test(activity) && /^\d+$/.test(attached)
        ? [{ name, activity: Number(activity), attached: Number(attached) }] : []
    })
  }

  async killPersistent(hostId: string, name: string): Promise<void> {
    requireTmuxName(name)
    // Close local tabs attached to it first; otherwise their auto-reconnect recreates the session with `new-session -A`.
    for (const [id, session] of this.sessions) if (session.hostId === hostId && session.tmuxName === name) await this.close(id)
    const result = await this.pool.exec(hostId, `tmux kill-session -t ${shellEscape('=' + name)}`)
    if (result.code !== 0) throw new Error(result.stderr.trim() || '无法结束持久会话')
  }

  private verifyHost(check: HostCheck): Promise<boolean> {
    const trust = this.known.judge(check.host, check.port, check.fingerprint)
    if (trust === 'trusted') return Promise.resolve(true)
    return this.requestPrompt('hostkey:prompt', check, false, (requestId, finish) => {
      this.prompts.set(requestId, { check, resolve: finish })
      return () => this.prompts.delete(requestId)
    }, { mismatch: trust === 'mismatch' })
  }

  private askKeyboard(request: KeyboardRequest): Promise<string[] | null> {
    return this.requestPrompt<string[] | null>('kbd:prompt', request, null, (requestId, finish) => {
      this.keyboards.set(requestId, finish)
      return () => this.keyboards.delete(requestId)
    })
  }

  private requestPrompt<T>(
    channel: string, request: { signal?: AbortSignal }, canceled: T,
    register: (id: string, finish: (value: T) => void) => () => void, extra = {}
  ): Promise<T> {
    const { signal, ...payload } = request
    if (signal?.aborted) return Promise.resolve(canceled)
    const requestId = randomUUID()
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: T, expired = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', expire)
        remove()
        if (expired) this.emit('prompt:expired', { requestId })
        resolve(value)
      }
      const expire = () => finish(canceled, true)
      const timer = setTimeout(expire, 120_000)
      const remove = register(requestId, finish)
      signal?.addEventListener('abort', expire, { once: true })
      this.emit(channel, { requestId, ...payload, ...extra })
    })
  }

  private create(id: string, kind: LiveSession['kind'], title: string, cols: number, rows: number, hostId?: string): LiveSession {
    const concurrency = this.vault.snapshot().settings.transferConcurrency
    const session: LiveSession = {
      id,
      kind,
      title,
      hostId,
      status: 'connecting',
      cols: clampDim(cols),
      rows: clampDim(rows),
      watchers: new Map(),
      queue: new TransferQueue(concurrency, (snapshot) => {
        const job = this.jobs.get(snapshot.id)
        if (!job) return
        job.status = snapshot.status
        if (snapshot.loaded) job.loaded = snapshot.loaded
        if (snapshot.total) job.total = snapshot.total
        if (snapshot.error) job.error = snapshot.error
        this.emit('transfer:event', { ...job })
        this.releaseRetiredFiles(session)
      })
    }
    this.sessions.set(id, session)
    return session
  }

  private enqueue(
    session: LiveSession,
    input: {
      direction: TransferJob['direction']
      name: string
      localPath: string
      remotePath: string
      total: number
      run: (hooks: { signal: AbortSignal; onProgress: (loaded: number, total: number) => void }) => Promise<void>
    }
  ): void {
    if (this.sessions.get(session.id) !== session) throw new Error('文件连接已关闭')
    const job: TransferJob = {
      id: randomUUID(),
      sessionId: session.id,
      hostId: session.hostId,
      direction: input.direction,
      name: input.name,
      localPath: input.localPath,
      remotePath: input.remotePath,
      loaded: 0,
      total: input.total,
      status: 'queued'
    }
    this.jobs.set(job.id, job)
    this.emit('transfer:event', { ...job })
    session.queue.setConcurrency(this.vault.snapshot().settings.transferConcurrency)
    session.queue.enqueue({
      id: job.id,
      run: async ({ signal, onProgress }) => {
        await input.run({
          signal,
          onProgress: (loaded, total) => {
            job.loaded = loaded
            job.total = total
            onProgress(loaded, total)
          }
        })
      }
    })
  }

  private async packUpload(
    session: LiveSession,
    localDir: string,
    remoteDir: string,
    hooks: { signal: AbortSignal; onProgress: (loaded: number, total: number) => void },
    cleanup: TransferCleanup
  ): Promise<void> {
    const tmp = path.join(os.tmpdir(), `hopline-${randomUUID()}.tar.gz`)
    const windows = process.platform === 'win32'
    const base = path.basename(localDir)
    try {
      const tarBin = windows
        ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
      try {
        // GNU headers support long paths on BusyBox, including archives made by Windows bsdtar.
        const format = windows ? ['--format', 'gnutar', '--options', 'hdrcharset=UTF-8'] : []
        const mac = process.platform === 'darwin'
        const metadata = mac ? ['--no-xattrs', '--no-mac-metadata'] : []
        await execFileAsync(tarBin, ['-czf', tmp, ...format, ...metadata, '-C', path.dirname(localDir), `./${base}`], {
          signal: hooks.signal,
          ...(mac ? { env: { ...process.env, COPYFILE_DISABLE: '1' } } : {})
        })
      } catch (tarError) {
        if (!windows || (tarError as NodeJS.ErrnoException).code !== 'ENOENT') throw tarError
        const { files, directories } = await walkLocal(localDir)
        const target = remoteJoin(remoteDir, base)
        const sftp = await this.sftpOf(session.id)
        for (const dir of [target, ...directories.map((entry) => remoteJoin(target, entry))]) {
          hooks.signal.throwIfAborted()
          await mkdirp(sftp, dir, cleanup.directories)
        }
        const total = files.reduce((sum, item) => sum + item.size, 0)
        let completed = 0
        for (const file of files) {
          hooks.signal.throwIfAborted()
          await uploadFile(
            await this.sftpOf(session.id),
            file.abs,
            remoteJoin(target, file.rel),
            {
              signal: hooks.signal,
              onProgress: (loaded) => hooks.onProgress(completed + loaded, total)
            },
            cleanup
          )
          completed += file.size
        }
        hooks.onProgress(total, total)
        return
      }
      const remoteTar = remoteJoin(remoteDir, windows ? `.hopline-upload-${randomUUID()}.tar.gz` : `${base}.tar.gz`)
      const sftp = await this.sftpOf(session.id)
      const lease = session.lease
      await uploadFile(sftp, tmp, remoteTar, hooks, cleanup)
      if (!lease || session.lease !== lease) throw new Error('连接已断开')
      const archive = shellEscape(remoteTar)
      const destination = shellEscape(remoteDir)
      let command = `tar -xzf ${archive} -C ${destination} && rm -f ${archive}`
      if (windows) {
        // Normalize only archived entries in a private staging directory. Re-extract with
        // umask 022 because BusyBox tar can ignore -p when running as a non-root user.
        const script = `set -e
umask 077
archive=${archive}
stage=
trap 'if [ -n "$stage" ]; then rm -rf -- "$stage"; fi; rm -f -- "$archive"' EXIT
stage=$(mktemp -d ${shellEscape(remoteJoin(remoteDir, '.hopline-stage.XXXXXXXX'))})
mkdir "$stage/content"
tar -xzf "$archive" -C "$stage/content"
root="$stage/content"/${shellEscape(base)}
[ -d "$root" ] && [ ! -L "$root" ] || exit 1
find "$root" -type d -exec chmod 755 {} +
find "$root" -type f -exec chmod 644 {} +
tar -cf "$stage/normalized.tar" -C "$stage/content" ${shellEscape(`./${base}`)}
find "$root" -type d -exec sh -c '
  content=$1
  destination=$2
  shift 2
  for entry do
    dir=$destination/\${entry#"$content/"}
    [ ! -L "$dir" ] || exit 1
    if [ ! -d "$dir" ]; then mkdir -m 755 "$dir" || exit 1; fi
    chmod 755 "$dir" || exit 1
  done
' sh "$stage/content" ${destination} {} +
umask 022
tar -xpf "$stage/normalized.tar" -C ${destination}`
        command = `sh -c ${shellEscape(script)}`
      }
      const result = await execOnClient(lease.client, command, { timeoutMs: 0, signal: hooks.signal })
      if (result.code !== 0) throw new Error(result.stderr.trim() || `远程解压失败 (${result.code})`)
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined)
    }
  }

  private async sftpOf(sessionId: string): Promise<SFTPWrapper> {
    const session = this.requireSsh(sessionId)
    if (session.filesOnly && !session.lease && !session.reconnecting) {
      const pending = this.attachFiles(session).finally(() => {
        if (session.reconnecting === pending) session.reconnecting = undefined
      })
      session.reconnecting = pending
    }
    if (session.reconnecting) {
      await session.reconnecting
      this.requireSsh(sessionId)
    }
    if (session.sftp) return session.sftp
    if (!session.lease) throw new Error('连接已断开')
    const existing = session.sftpPromise
    if (existing) return existing
    const lease = session.lease
    const pending = new Promise<SFTPWrapper>((resolve, reject) => {
      lease.client.sftp((error, sftp) => {
        if (session.lease !== lease || this.sessions.get(sessionId) !== session) {
          sftp?.end()
          reject(new Error('会话连接已失效'))
          return
        }
        if (error || !sftp) reject(error ?? new Error('无法打开 SFTP'))
        else {
          session.sftp = sftp
          const reset = () => { if (session.sftp === sftp) session.sftp = undefined }
          sftp.on?.('close', reset)
          sftp.on?.('error', reset)
          resolve(sftp)
        }
      })
    }).finally(() => {
      if (session.sftpPromise === pending) session.sftpPromise = undefined
    })
    session.sftpPromise = pending
    return pending
  }

  private async attachFiles(session: LiveSession): Promise<void> {
    // Never move queued work or an external edit to a changed endpoint after a drop.
    if (session.filesRetired || session.filesConfig !== this.fileConfig(session.hostId!)) {
      throw new Error('主机连接配置已更改，请重新打开文件')
    }
    const controller = new AbortController()
    session.connecting ??= new Set()
    session.connecting.add(controller)
    session.status = 'connecting'
    try {
      const lease = await this.pool.acquire(session.hostId!, { signal: controller.signal })
      if (this.sessions.get(session.id) !== session || controller.signal.aborted) {
        lease.release()
        throw new Error('文件连接已关闭')
      }
      if (!this.vault.getHost(session.hostId!) || session.filesConfig !== this.fileConfig(session.hostId!)) {
        lease.release()
        throw new Error('主机连接配置已更改，请重新打开文件')
      }
      session.lease = lease
      session.status = 'connected'
      session.offDrop = lease.onDrop(() => {
        if (session.lease !== lease) return
        session.status = 'closed'
        session.lease = undefined
        session.sftp = undefined
        session.sftpPromise = undefined
        lease.release()
      })
    } catch (error) {
      session.status = 'error'
      throw error
    } finally {
      session.connecting.delete(controller)
    }
  }

  private fileConfig(hostId: string): string {
    const stored = this.vault.snapshot().hosts.find((item) => item.id === hostId && item.deletedAt === null)
    if (!stored) throw new Error('主机不存在')
    // Compare encrypted credential payloads without decrypting or retaining secrets.
    return createHash('sha256').update(JSON.stringify([stored.host, stored.port, stored.username, stored.authType, stored.agent,
      stored.passwordEnc, stored.privateKeyEnc, stored.privateKeyPath, stored.passphraseEnc, stored.proxy, stored.jumps])).digest('hex')
  }

  private releaseRetiredFiles(session: LiveSession): void {
    if (!session.filesRetired || session.watchers.size ||
      session.queue.list().some((job) => job.status === 'queued' || job.status === 'running')) return
    void this.close(session.id).catch((error: unknown) => logError('retired file connection close failed', error))
  }

  private require(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在')
    return session
  }

  private requireSsh(sessionId: string): LiveSession {
    const session = this.require(sessionId)
    if (session.kind !== 'ssh') throw new Error('当前不是 SSH 会话')
    return session
  }
}

function readEditManifest(file: string): EditManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EditManifest> | null
    if (!value || typeof value !== 'object' || typeof value.remotePath !== 'string' || !value.remotePath ||
      typeof value.hostId !== 'string' || !value.hostId || typeof value.dirty !== 'boolean' ||
      !value.savedLocal || !Number.isSafeInteger(value.savedLocal.size) || value.savedLocal.size < 0 ||
      !Number.isFinite(value.savedLocal.mtimeMs) ||
      (value.error !== undefined && typeof value.error !== 'string') ||
      (value.conflict !== undefined && typeof value.conflict !== 'boolean')) return null
    return value as EditManifest
  } catch {
    return null
  }
}

function recoverStartupEdits(userData: string): { recovered: string[]; failed: string | null } {
  const root = path.join(userData, 'watch')
  const recovered: string[] = []
  if (!fs.existsSync(root)) return { recovered, failed: null }
  try {
    rescueStartupEdits(userData, root, recovered)
  } catch (error) {
    // Startup must continue; the untouched copies are retried on the next launch.
    logError(`startup edit recovery failed, keeping ${root}`, error)
    return { recovered, failed: root }
  }
  return { recovered, failed: null }
}

function rescueStartupEdits(userData: string, root: string, recovered: string[]): void {
  const rescue = (file: string) => {
    const target = recoverLocalFile(file, path.join(userData, 'recovered'))
    recovered.push(target)
    logInfo(`startup edit recovered ${file} -> ${target}`)
  }
  const filesIn = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? filesIn(file) : entry.isFile() ? [file] : []
  })
  // Inspect only files under watch; metadata paths never select filesystem targets.
  for (const session of fs.readdirSync(root, { withFileTypes: true })) {
    const sessionDir = path.join(root, session.name)
    if (session.isFile()) rescue(sessionDir)
    if (!session.isDirectory()) continue
    for (const item of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      const dir = path.join(sessionDir, item.name)
      if (item.isFile()) rescue(dir) // Legacy caches without a per-edit directory.
      if (!item.isDirectory()) continue
      const manifestPath = path.join(dir, EDIT_MANIFEST)
      const manifest = readEditManifest(manifestPath)
      const allFiles = filesIn(dir)
      let payloads = allFiles.filter((file) => file !== manifestPath && file !== `${manifestPath}.tmp`)
      // An old cache could itself be named like the new metadata file.
      if (!manifest && payloads.length === 0) payloads = allFiles
      for (const file of payloads) {
        const local = fs.statSync(file)
        if (!manifest || manifest.dirty || path.basename(file) !== path.posix.basename(manifest.remotePath) ||
          local.size !== manifest.savedLocal.size || local.mtimeMs !== manifest.savedLocal.mtimeMs) rescue(file)
      }
    }
  }
  // If any rescue fails, execution never reaches deletion: the original remains retryable.
  fs.rmSync(root, { recursive: true, force: true })
}

function openWithWindowsNotepad(localPath: string): Promise<boolean> {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const notepad = path.win32.join(systemRoot, 'System32', 'notepad.exe')
  return new Promise((resolve) => {
    try {
      const child = spawn(notepad, [localPath], { detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

/** Synchronous metadata operations allow startup recovery before any UI exists. */
function recoverLocalFile(localPath: string, dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  safeChmodSync(dir, 0o700)
  const current = fs.lstatSync(localPath)
  if (!current.isFile() || current.nlink !== 1) throw new Error('本地编辑副本包含链接，无法安全恢复')
  const descriptor = fs.openSync(localPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('本地编辑副本已改变，无法安全恢复')
    }
    safeChmodSync(descriptor, 0o600)
  } finally { fs.closeSync(descriptor) }
  const now = new Date()
  const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, '0')).join('')
  let attempt = 0
  let recoveredPath: string
  for (;;) {
    const suffix = attempt === 0 ? '' : `-${attempt}`
    recoveredPath = path.join(dir, `${stamp}${suffix}-${path.basename(localPath)}`)
    try {
      fs.closeSync(fs.openSync(recoveredPath, 'wx', 0o600))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      attempt += 1
    }
  }
  try {
    renameReplaceSync(localPath, recoveredPath)
  } catch (error) {
    fs.unlinkSync(recoveredPath)
    throw error
  }
  return recoveredPath
}

async function walkRemote(sftp: SFTPWrapper, dir: string, prefix = ''): Promise<{ remote: string; rel: string; size: number }[]> {
  const entries = await listDirectory(sftp, dir)
  const files: { remote: string; rel: string; size: number }[] = []
  for (const entry of entries) {
    assertDownloadName(entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory) files.push(...(await walkRemote(sftp, entry.path, rel)))
    else files.push({ remote: entry.path, rel, size: entry.size })
  }
  return files
}

function toInfo(session: LiveSession): SessionInfo {
  return {
    id: session.id,
    kind: session.kind,
    title: session.title,
    hostId: session.hostId,
    status: session.status,
    message: session.message,
    ...(session.tmuxName ? { tmuxName: session.tmuxName, tmuxMissing: session.tmuxMissing } : {}),
    ...(session.shellHostname ? { shellHostname: session.shellHostname } : {})
  }
}

function clampDim(value: number): number {
  if (!Number.isFinite(value)) return 24
  return Math.max(2, Math.min(500, Math.round(value)))
}

function localShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return resolveWindowsShell()
  const file = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { file, args: ['-l'] }
}

async function loadPty(): Promise<typeof import('node-pty') | null> {
  try {
    // POSIX node-pty rewrites app.asar in its own helper path. Keep its logical
    // module path to avoid app.asar.unpacked.unpacked when spawning the helper.
    const unpacked = process.platform === 'win32'
      ? resolveAsarUnpackedModule('node-pty', import.meta.url)
      : 'node-pty'
    const imported = unpacked !== 'node-pty'
      ? createRequire(import.meta.url)(unpacked)
      : await import('node-pty')
    const mod = imported as typeof import('node-pty') & { default?: typeof import('node-pty') }
    return typeof mod.spawn === 'function' ? mod : (mod.default ?? null)
  } catch (error) {
    logError('node-pty unavailable', error)
    return null
  }
}

export function seedDemo(vault: Vault, extras?: { host: string; port: number; username: string; keyPath: string }): void {
  if (vault.listHosts().length > 0 && !extras) return
  if (vault.listHosts().length === 0) {
    const prod = vault.saveGroup({ name: '生产' })
    const lab = vault.saveGroup({ name: '实验' })
    vault.saveHost({
      groupId: prod.id,
      name: 'edge',
      host: '10.0.8.2',
      port: 22,
      username: 'root',
      authType: 'password'
    })
    vault.saveHost({
      groupId: prod.id,
      name: 'api-1',
      host: '10.0.8.11',
      port: 22,
      username: 'deploy',
      authType: 'privateKey',
      privateKeyPath: '~/.ssh/id_ed25519'
    })
    vault.saveHost({
      groupId: lab.id,
      name: 'gpu-box',
      host: '192.168.4.20',
      port: 22,
      username: 'lab',
      authType: 'keyboard-interactive'
    })
    vault.saveHost({
      groupId: lab.id,
      name: '日志机',
      host: '10.1.0.6',
      port: 22,
      username: 'ops',
      authType: 'password'
    })
  }
  if (extras && !vault.listHosts().some((host) => host.name === '本机')) {
    vault.saveHost({
      groupId: null,
      name: '本机',
      host: extras.host,
      port: extras.port,
      username: extras.username,
      authType: 'privateKey',
      privateKeyPath: extras.keyPath
    })
  }
}

function requireTmuxName(value: string): string {
  if (typeof value !== 'string' || !/^hopline-[a-zA-Z0-9]{6}$/.test(value)) throw new Error('持久会话名称不合法')
  return value
}

export function integrationShellCommand(startup: string | null): string {
  // Leading space keeps it out of history where HISTCONTROL/HIST_IGNORE_SPACE is set.
  return ` export HOPLINE_SHELL_INTEGRATION=1; ${startup ? `${startup}\n` : ''}exec "$SHELL" -l`
}
