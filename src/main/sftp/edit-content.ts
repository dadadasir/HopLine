import { createHash } from 'node:crypto'
import { addAbortSignal, type Readable } from 'node:stream'

export const EDIT_LIMIT = 20 * 1024 * 1024

/** Bound actual bytes, including servers/files that grow after stat(). */
export async function editContent(stream: Readable, signal: AbortSignal, retain = false): Promise<{ digest: string; content: Buffer }> {
  addAbortSignal(signal, stream)
  const hash = createHash('sha256'), chunks: Buffer[] = []
  let size = 0
  try {
    signal.throwIfAborted()
    for await (const chunk of stream) {
      signal.throwIfAborted()
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > EDIT_LIMIT) throw new Error('文件超过 20 MB，请改为下载')
      hash.update(bytes)
      if (retain) chunks.push(bytes)
    }
    signal.throwIfAborted()
    return { digest: hash.digest('hex'), content: retain ? Buffer.concat(chunks, size) : Buffer.alloc(0) }
  } finally { stream.destroy() }
}
