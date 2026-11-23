import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ATOMIC_EDIT_FIXTURE_RUNNER } from './atomic-edit-python.mjs'

const require = createRequire(import.meta.url)
const { Server, utils } = require('ssh2')
const { flagsToString, STATUS_CODE } = utils.sftp
let cachedHostKey

function validatedHostKey() {
  if (cachedHostKey) return cachedHostKey
  let lastError
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const key = utils.generateKeyPairSync('ed25519').private
      const parsed = utils.parseKey(key)
      if (parsed instanceof Error) throw parsed
      cachedHostKey = key
      return key
    } catch (error) {
      lastError = error
    }
  }
  throw new Error('无法生成有效的测试 SSH 主机密钥（已重试 5 次）', { cause: lastError })
}

/**
 * A tiny loopback SSH server for tests and screenshots.
 * Password and public-key auth, a one-line shell banner, and SFTP backed by a temp directory.
 */
export async function startMiniSshd(options = {}) {
  const username = options.username || 'hop'
  const password = options.password ?? null
  const publicKeys = (Array.isArray(options.publicKey) ? options.publicKey : options.publicKey ? [options.publicKey] : []).map(loadPublicKey)
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-ssh-'))
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(root, 'readme.txt'), 'Hopline\n')
  fs.writeFileSync(path.join(root, 'notes', 'today.txt'), 'quiet machines\n')

  const hostKey = validatedHostKey()
  const clients = new Set()
  let acceptedConnections = 0
  let activeExecs = 0
  const shellSizes = []
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    acceptedConnections++
    clients.add(client)
    // OpenSSH enables TCP_NODELAY; without it Linux loopback adds ~40 ms per SFTP round trip.
    client.setNoDelay(true)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      options.onAuthentication?.(ctx)
      if (options.authenticate) { options.authenticate(ctx); return }
      if (ctx.username !== username) return ctx.reject()
      if (ctx.method === 'password' && password != null && safeEqual(ctx.password, password)) return ctx.accept()
      if (ctx.method === 'publickey' && publicKeys.some((key) => sameKey(ctx, key))) return ctx.accept()
      if (ctx.method === 'none') return ctx.reject(['publickey', 'password'])
      return ctx.reject()
    })
    if (options.tcpipForward) {
      const forwards = new Map()
      client.on('request', (accept, reject, name, info) => {
        const key = `${info.bindAddr}:${info.bindPort}`
        if (name === 'cancel-tcpip-forward') {
          const listener = forwards.get(key)
          if (!listener) return reject()
          listener.close(); forwards.delete(key); accept(); return
        }
        if (name !== 'tcpip-forward' || forwards.has(key)) return reject()
        const listener = createServer((socket) => {
          client.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress, socket.remotePort, (error, stream) => {
            if (error) { socket.destroy(); return }
            stream.on('error', () => socket.destroy())
            stream.on('close', () => socket.destroy())
            socket.on('error', () => stream.destroy())
            socket.on('close', () => stream.destroy())
            socket.pipe(stream).pipe(socket)
          })
          socket.on('error', () => {})
          const close = () => socket.destroy()
          client.once('close', close)
          socket.once('close', () => client.off('close', close))
        })
        listener.once('error', () => { forwards.delete(key); reject() })
        forwards.set(key, listener)
        listener.listen(info.bindPort, info.bindAddr, () => accept(listener.address().port))
      })
      client.once('close', () => { for (const listener of forwards.values()) listener.close() })
    }
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const socket = createConnection({ host: info.destIP, port: info.destPort })
        let stream
        socket.once('connect', () => {
          stream = accept()
          if (!stream) { socket.destroy(); return }
          stream.on('error', () => socket.destroy())
          stream.on('close', () => socket.destroy())
          socket.pipe(stream).pipe(socket)
        })
        socket.on('error', () => {
          if (stream) stream.close()
          else reject()
        })
        client.once('close', () => socket.destroy())
      })
      client.on('session', (accept) => {
        const session = accept()
        if (options.onAgentForward) session.on('auth-agent', (acceptAgent) => {
          options.onAgentForward()
          acceptAgent()
        })
        let dimensions = { cols: 0, rows: 0 }
        session.on('pty', (acceptPty, _reject, info) => {
          dimensions = { cols: info.cols, rows: info.rows }
          acceptPty()
        })
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          shellSizes.push(dimensions)
          stream.write('hop-shell-ready\r\n$ ')
          stream.on('data', (data) => {
            const text = data.toString('utf8')
            if (text.includes('\u0003') || text.includes('\u0004')) {
              stream.exit(0)
              stream.close()
              return
            }
            const line = text.replace(/\r/g, '').trim()
            if (line) stream.write(`${line}\r\n`)
            stream.write('$ ')
          })
        })
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          activeExecs++
          const atomicFixture = options.atomicEditFixture && info.command.startsWith('python3 -c ') && info.command.includes('class Refused(Exception): pass')
          const child = atomicFixture
            ? spawn('python3', ['-c', ATOMIC_EDIT_FIXTURE_RUNNER, info.command, root], { cwd: root, timeout: 20_000 })
            : spawn('bash', ['--noprofile', '--norc', '-c', info.command], { cwd: root, timeout: 20_000 })
          stream.pipe(child.stdin)
          child.stdout.pipe(stream, { end: false })
          child.stderr.pipe(stream.stderr, { end: false })
          child.stdin.on('error', () => {})
          stream.on('error', () => child.kill())
          stream.once('close', () => {
            activeExecs--
            child.kill()
          })
          child.once('error', () => {
            stream.exit(1)
            stream.close()
          })
          child.once('close', (code, signal) => {
            if (signal) stream.exit(signal)
            else stream.exit(code ?? 1)
            stream.close()
          })
        })
        session.on('sftp', (acceptSftp) => attachSftp(acceptSftp(), root, options))
      })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法监听测试 SSH 端口')

  return {
    port: address.port,
    root,
    username,
    get acceptedConnections() { return acceptedConnections },
    get activeConnections() { return clients.size },
    get activeExecs() { return activeExecs },
    shellSizes,
    disconnectAll: () => { for (const client of clients) client.end() },
    close: () =>
      new Promise((resolve) => {
        for (const client of clients) client.end()
        server.close(() => resolve())
      })
  }
}

function loadPublicKey(file) {
  const parsed = utils.parseKey(fs.readFileSync(file))
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key || key instanceof Error) throw new Error('无法解析公钥')
  return key.getPublicSSH()
}

function sameKey(ctx, allowed) {
  return [ctx.blob, ctx.key?.data].some((buf) => Buffer.isBuffer(buf) && buf.equals(allowed))
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return a.equals(b)
}

function attachSftp(sftp, root, options) {
  const handles = new Map()
  let next = 1

  const replyError = (reqid, error) => {
    if (process.env.HOPLINE_SSH_DEBUG) console.error('SFTP status', error && error.code, error && error.message)
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    sftp.status(reqid, missing ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE)
  }

  sftp.on('REALPATH', (reqid, target) => {
    if (process.env.HOPLINE_SSH_DEBUG) console.error('REALPATH', JSON.stringify(target))
    try {
      const resolved = resolvePath(root, target || '.')
      const shown = virtualPath(root, resolved)
      const stat = fs.statSync(resolved)
      sftp.name(reqid, [{ filename: shown, longname: shown, attrs: attrsOf(stat) }])
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('STAT', (reqid, target) => {
    if (process.env.HOPLINE_SSH_DEBUG) console.error('STAT', JSON.stringify(target))
    statReply(sftp, reqid, target, root, replyError)
  })
  sftp.on('LSTAT', (reqid, target) => {
    if (process.env.HOPLINE_SSH_DEBUG) console.error('LSTAT', JSON.stringify(target))
    statReply(sftp, reqid, target, root, replyError, false)
  })
  sftp.on('OPENDIR', (reqid, target) => {
    if (process.env.HOPLINE_SSH_DEBUG) console.error('OPENDIR', JSON.stringify(target))
    try {
      const dir = resolvePath(root, target)
      const entries = fs.readdirSync(dir).map((name) => entry(path.join(dir, name), name))
      const id = alloc(handles, next++, { kind: 'dir', entries, index: 0, path: dir })
      sftp.handle(reqid, id)
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('READDIR', (reqid, handle) => {
    const state = handles.get(keyOf(handle))
    if (!state || state.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
    if (state.index >= state.entries.length) return sftp.status(reqid, STATUS_CODE.EOF)
    const batch = state.entries.slice(state.index, state.index + 64)
    state.index += batch.length
    sftp.name(reqid, batch)
  })
  sftp.on('OPEN', (reqid, filename, flags, attrs) => {
    try {
      const file = resolvePath(root, filename)
      const mode = flagsToString(flags) || 'r'
      const fd = fs.openSync(file, mode, attrs.mode)
      const id = alloc(handles, next++, { kind: 'file', fd, path: file })
      sftp.handle(reqid, id)
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('READ', (reqid, handle, offset, length) => {
    const state = handles.get(keyOf(handle))
    if (!state || state.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
    const buffer = Buffer.alloc(length)
    fs.read(state.fd, buffer, 0, length, offset, (error, bytes) => {
      if (error) return replyError(reqid, error)
      if (!bytes) return sftp.status(reqid, STATUS_CODE.EOF)
      options.onRead?.({ path: virtualPath(root, state.path), offset, length: bytes })
      sftp.data(reqid, buffer.subarray(0, bytes))
    })
  })
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const state = handles.get(keyOf(handle))
    if (!state || state.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
    fs.write(state.fd, data, 0, data.length, offset, (error, bytes) => {
      if (error) replyError(reqid, error)
      else {
        options.onWrite?.({ path: virtualPath(root, state.path), offset, length: bytes })
        sftp.status(reqid, STATUS_CODE.OK)
      }
    })
  })
  sftp.on('FSTAT', (reqid, handle) => {
    const state = handles.get(keyOf(handle))
    if (!state) return sftp.status(reqid, STATUS_CODE.FAILURE)
    if (state.kind === 'file') {
      fs.fstat(state.fd, (error, stat) => {
        if (error) replyError(reqid, error)
        else sftp.attrs(reqid, attrsOf(stat))
      })
      return
    }
    try {
      sftp.attrs(reqid, attrsOf(fs.statSync(state.path)))
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('CLOSE', (reqid, handle) => {
    const id = keyOf(handle)
    const state = handles.get(id)
    handles.delete(id)
    if (state?.kind === 'file') fs.close(state.fd, () => {
      // Opt-in test gate: the handle is already invalid while CLOSE is pending.
      if (options.beforeFileCloseReply) {
        options.beforeFileCloseReply().then(() => sftp.status(reqid, STATUS_CODE.OK))
      } else sftp.status(reqid, STATUS_CODE.OK)
    })
    else sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('MKDIR', (reqid, target) => {
    try {
      fs.mkdirSync(resolvePath(root, target))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('REMOVE', (reqid, target) => {
    try {
      fs.unlinkSync(resolvePath(root, target))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('RMDIR', (reqid, target) => {
    try {
      fs.rmdirSync(resolvePath(root, target))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('RENAME', (reqid, from, to) => {
    try {
      // SFTP v3 RENAME cannot replace an existing destination.
      if (fs.existsSync(resolvePath(root, to))) return sftp.status(reqid, STATUS_CODE.FAILURE)
      fs.renameSync(resolvePath(root, from), resolvePath(root, to))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('EXTENDED', (reqid, name, data) => {
    if (name !== 'posix-rename@openssh.com') return sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED)
    try {
      const fromLength = data.readUInt32BE(0)
      const from = data.subarray(4, 4 + fromLength).toString()
      const toLength = data.readUInt32BE(4 + fromLength)
      const to = data.subarray(8 + fromLength, 8 + fromLength + toLength).toString()
      fs.renameSync(resolvePath(root, from), resolvePath(root, to))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('SETSTAT', (reqid, target, attrs) => {
    try {
      const file = resolvePath(root, target)
      if (attrs.mode !== undefined) fs.chmodSync(file, attrs.mode)
      if (attrs.size !== undefined) fs.truncateSync(file, attrs.size)
      if (attrs.atime !== undefined && attrs.mtime !== undefined) fs.utimesSync(file, attrs.atime, attrs.mtime)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('FSETSTAT', (reqid, handle, attrs) => {
    const state = handles.get(keyOf(handle))
    if (!state || state.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
    try {
      if (attrs.mode !== undefined) fs.fchmodSync(state.fd, attrs.mode)
      if (attrs.size !== undefined) fs.ftruncateSync(state.fd, attrs.size)
      if (attrs.atime !== undefined && attrs.mtime !== undefined) fs.futimesSync(state.fd, attrs.atime, attrs.mtime)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (error) {
      replyError(reqid, error)
    }
  })
  sftp.on('close', () => {
    for (const state of handles.values()) {
      if (state.kind === 'file') {
        try { fs.closeSync(state.fd) } catch { /* Already closing. */ }
      }
    }
    handles.clear()
  })
}

function statReply(sftp, reqid, target, root, replyError, followLinks = true) {
  try {
    sftp.attrs(reqid, attrsOf((followLinks ? fs.statSync : fs.lstatSync)(resolvePath(root, target))))
  } catch (error) {
    replyError(reqid, error)
  }
}

function resolvePath(root, target) {
  const raw = !target || target === '.' ? '/' : String(target)
  const normalized = path.posix.normalize(raw.startsWith('/') ? raw : `/${raw}`)
  if (!normalized.startsWith('/') || normalized.split('/').includes('..')) {
    const error = new Error('bad path')
    error.code = 'ENOENT'
    throw error
  }
  const rel = normalized === '/' ? '' : normalized.slice(1)
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const error = new Error('path escapes root')
    error.code = 'ENOENT'
    throw error
  }
  return resolved
}

function virtualPath(root, abs) {
  if (abs === root) return '/'
  return `/${path.relative(root, abs).split(path.sep).join('/')}`
}

function entry(abs, name = path.basename(abs) || abs) {
  const stat = fs.lstatSync(abs)
  return { filename: name, longname: name, attrs: attrsOf(stat) }
}

function attrsOf(stat) {
  return {
    mode: stat.mode,
    size: stat.size,
    uid: stat.uid,
    gid: stat.gid,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000)
  }
}

function alloc(handles, id, state) {
  handles.set(id, state)
  const handle = Buffer.alloc(4)
  handle.writeUInt32BE(id)
  return handle
}

function keyOf(handle) {
  return handle.readUInt32BE(0)
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (invoked) {
  const server = await startMiniSshd({
    username: process.env.HOPLINE_SSH_USER || process.env.USER || 'hop',
    password: process.env.HOPLINE_SSH_PASSWORD || null,
    publicKey: process.env.HOPLINE_SSH_PUB || null,
    root: process.env.HOPLINE_SSH_ROOT || null
  })
  console.log(`MINI_SSH_PORT=${server.port}`)
  console.log(`MINI_SSH_ROOT=${server.root}`)
  process.on('SIGTERM', () => server.close().then(() => process.exit(0)))
  process.on('SIGINT', () => server.close().then(() => process.exit(0)))
}
