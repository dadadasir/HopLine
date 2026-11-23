import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SFTPWrapper } from 'ssh2'

/** SFTP callbacks need not arrive after the channel is closed. */
function request<T>(sftp: SFTPWrapper, signal: AbortSignal, send: (done: (error?: Error | null, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      sftp.removeListener('close', disconnected)
      sftp.removeListener('end', disconnected)
      sftp.removeListener('error', finish)
      if (error) reject(error)
      else resolve(value as T)
    }
    const aborted = () => finish(Object.assign(new Error('远程编辑已中止'), { name: 'AbortError' }))
    const disconnected = () => finish(new Error('连接已断开'))
    const timer = setTimeout(() => finish(new Error('远程编辑目录校验超时')), 5000)
    signal.addEventListener('abort', aborted, { once: true })
    sftp.once('close', disconnected)
    sftp.once('end', disconnected)
    sftp.once('error', finish)
    if (signal.aborted) { aborted(); return }
    try { send(finish) } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}

/** Prove that SSH exec and SFTP address the same directory before editing. */
export async function withEditNamespace<T>(sftp: SFTPWrapper, remotePath: string, signal: AbortSignal,
  action: (absolutePath: string, proof: { name: string; token: string }) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const parent = await request<string>(sftp, signal, done => sftp.realpath(path.posix.dirname(remotePath), done))
  const absolutePath = path.posix.join(parent, path.posix.basename(remotePath))
  const proof = { name: `.hopline-edit-probe-${randomUUID()}`, token: randomUUID() }
  const probePath = path.posix.join(parent, proof.name)
  const handle = await request<Buffer>(sftp, signal, done => sftp.open(probePath, 'wx', 0o600, done))
  let closed = false
  try {
    const bytes = Buffer.from(proof.token)
    await request(sftp, signal, done => sftp.write(handle, bytes, 0, bytes.length, 0, done))
    await request(sftp, signal, done => sftp.close(handle, done))
    closed = true
    signal.throwIfAborted()
    return await action(absolutePath, proof)
  } finally {
    // During cancellation the session can already have ended SFTP. Do not wait
    // for callbacks from that channel; only non-secret random nonce data remains.
    if (signal.aborted) {
      try { if (!closed) sftp.close(handle, () => undefined) } catch { /* closed */ }
      try { sftp.unlink(probePath, () => undefined) } catch { /* closed */ }
    } else {
      if (!closed) await request(sftp, signal, done => sftp.close(handle, done)).catch(() => undefined)
      await request(sftp, signal, done => sftp.unlink(probePath, done)).catch(() => undefined)
    }
  }
}
