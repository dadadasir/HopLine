export function joinUrl(base: string, ...parts: string[]): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  const suffix = parts
    .flatMap((part) => part.split('/'))
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join('/')
  return suffix ? `${trimmed}/${suffix}` : trimmed
}

export function basicAuthHeader(username: string, password: string): string {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  return `Basic ${token}`
}

export interface WebDavEntry {
  href: string
  name: string
  lastModified?: string
}

/** Minimal PROPFIND parser for the href + getlastmodified fields we care about. */
export function parsePropfind(xml: string): WebDavEntry[] {
  // Never scan through another '<': malformed bounded XML must still take
  // linear work instead of retrying a long [^>]* match at every opening angle.
  const responses = xml.split(/<(?:[\w.-]+:)?response\b[^<>]*>/i).slice(1)
  const entries: WebDavEntry[] = []
  for (const block of responses) {
    const hrefMatch = block.match(/<(?:[\w.-]+:)?href\b[^<>]*>([^<]+)<\/(?:[\w.-]+:)?href\s*>/i)
    if (!hrefMatch) continue
    let href = hrefMatch[1]!.trim()
    try {
      href = decodeURIComponent(href)
    } catch {
      // Some servers return literal percent signs in hrefs.
    }
    const modified = block.match(/<(?:[\w.-]+:)?getlastmodified\b[^<>]*>([^<]+)<\/(?:[\w.-]+:)?getlastmodified\s*>/i)
    const name = href.replace(/\/+$/, '').split('/').pop() || href
    entries.push({
      href,
      name,
      lastModified: modified?.[1]?.trim()
    })
  }
  return entries
}

export interface WebDavTarget {
  url: string
  username: string
  password: string
  remoteDir: string
}

export const WEBDAV_LIST_MAX_BYTES = 1024 * 1024
export const WEBDAV_BACKUP_MAX_BYTES = 64 * 1024 * 1024

interface WebDavOperation {
  signal?: AbortSignal
  check?: () => void
}

// Error responses and successful uploads can have arbitrary response bodies.
// Cancel rather than drain them; a peer must not keep the operation alive with
// an endless body after its headers have already answered the request.
function release(response: Response): void {
  void response.body?.cancel().catch(() => undefined)
}

export class WebDavClient {
  constructor(private readonly target: WebDavTarget, private readonly operation: WebDavOperation = {}) {}

  private check(): void {
    this.operation.check?.()
    this.operation.signal?.throwIfAborted()
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    this.check()
    const response = await fetch(url, { ...init, signal: this.operation.signal })
    // A successful PUT status confirms the remote commit. A cancellation that
    // raced with that acknowledgement cannot turn it into a failed upload.
    try { if (init.method !== 'PUT' || !response.ok) this.check(); return response }
    catch (error) { release(response); throw error }
  }

  private async read(response: Response, limit: number, errorKey: string): Promise<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const abort = () => { void reader?.cancel().catch(() => undefined) }
    try {
      if (Number(response.headers.get('content-length')) > limit) throw new Error(errorKey)
      if (!response.body) return new Uint8Array()
      reader = response.body.getReader()
      this.operation.signal?.addEventListener('abort', abort, { once: true })
      const chunks: Uint8Array[] = []
      let bytes = 0
      for (;;) {
        this.check()
        const { done, value } = await reader.read()
        this.check()
        if (done) break
        bytes += value.byteLength
        if (bytes > limit) throw new Error(errorKey)
        chunks.push(value)
      }
      const result = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
      return result
    } finally {
      this.operation.signal?.removeEventListener('abort', abort)
      if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock() }
      else release(response)
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: basicAuthHeader(this.target.username, this.target.password),
      ...extra
    }
  }

  fileUrl(name: string): string {
    return joinUrl(this.target.url, this.target.remoteDir, name)
  }

  async put(name: string, body: Uint8Array): Promise<void> {
    this.check()
    if (body.byteLength > WEBDAV_BACKUP_MAX_BYTES) throw new Error('backup.webdavBackupTooLarge')
    const upload = () => this.request(this.fileUrl(name), {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: Buffer.from(body)
    })
    let response = await upload()
    if (response.status === 404 || response.status === 409) {
      release(response)
      await this.ensureDirectory()
      response = await upload()
    }
    try { if (!response.ok) throw new Error(`WebDAV 上传失败 (${response.status})`) }
    finally { release(response) }
  }

  private async ensureDirectory(): Promise<void> {
    let url = joinUrl(this.target.url)
    for (const part of this.target.remoteDir.split('/').filter(Boolean)) {
      url = joinUrl(url, part)
      const response = await this.request(url, { method: 'MKCOL', headers: this.headers() })
      try { if (response.status !== 201 && response.status !== 405) throw new Error(`WebDAV 创建目录失败 (${response.status})`) }
      finally { release(response) }
    }
  }

  async get(name: string): Promise<Uint8Array> {
    const response = await this.request(this.fileUrl(name), {
      method: 'GET',
      headers: this.headers()
    })
    if (!response.ok) {
      release(response)
      throw new Error(`WebDAV 下载失败 (${response.status})`)
    }
    return this.read(response, WEBDAV_BACKUP_MAX_BYTES, 'backup.webdavBackupTooLarge')
  }

  async list(): Promise<WebDavEntry[]> {
    const url = joinUrl(this.target.url, this.target.remoteDir)
    const response = await this.request(url.endsWith('/') ? url : `${url}/`, {
      method: 'PROPFIND',
      headers: this.headers({ Depth: '1', 'Content-Type': 'application/xml' }),
      body: '<?xml version="1.0" encoding="utf-8" ?><propfind xmlns="DAV:"><prop><getlastmodified/></prop></propfind>'
    })
    if (!response.ok && response.status !== 207) {
      release(response)
      throw new Error(`WebDAV 列目录失败 (${response.status})`)
    }
    return parsePropfind(new TextDecoder().decode(await this.read(response, WEBDAV_LIST_MAX_BYTES, 'backup.webdavListTooLarge')))
  }
}
