import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePropfind, WebDavClient, WEBDAV_BACKUP_MAX_BYTES, WEBDAV_LIST_MAX_BYTES } from '../src/core/webdav'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const target = { url: 'https://dav.test', username: 'u', password: 'p', remoteDir: 'backups' }

function streamed(bytes: number, headers?: HeadersInit, keepOpen = false) {
  const cancel = vi.fn(), chunk = new Uint8Array(Math.min(bytes, 64 * 1024))
  let left = bytes
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!left) { if (!keepOpen) controller.close(); return }
      const length = Math.min(left, chunk.length); controller.enqueue(chunk.subarray(0, length)); left -= length
    }, cancel
  })
  return { response: new Response(body, { headers }), cancel }
}

describe('bounded WebDAV response streams', () => {
  it('handles a bounded listing full of malformed opening angles without a regex stall', () => {
    expect(parsePropfind('<'.repeat(WEBDAV_LIST_MAX_BYTES))).toEqual([])
    expect(parsePropfind(`<d:response>${'<'.repeat(WEBDAV_LIST_MAX_BYTES - 100)}</d:response>`)).toEqual([])
    expect(parsePropfind('<response><href>/backup</href>' + '<'.repeat(WEBDAV_LIST_MAX_BYTES - 100))).toEqual([{ href: '/backup', name: 'backup', lastModified: undefined }])
  }, 1_000)
  for (const [method, max, key] of [
    ['list', WEBDAV_LIST_MAX_BYTES, 'backup.webdavListTooLarge'],
    ['get', WEBDAV_BACKUP_MAX_BYTES, 'backup.webdavBackupTooLarge']
  ] as const) {
    it.each([undefined, { 'content-length': '1' }])(`${method} rejects actual bytes over its limit even with absent or understated length`, async (headers) => {
      const { response, cancel } = streamed(max + 1, headers, true)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      const client = new WebDavClient(target)
      await expect(method === 'list' ? client.list() : client.get('backup')).rejects.toThrow(key)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(response.body?.locked).toBe(false)
    })
    it(`${method} rejects oversized declared length before reading and releases the body`, async () => {
      const { response, cancel } = streamed(max + 1, { 'content-length': String(max + 1) })
      const reader = vi.spyOn(response.body!, 'getReader')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      const client = new WebDavClient(target)
      await expect(method === 'list' ? client.list() : client.get('backup')).rejects.toThrow(key)
      expect(reader).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1)
    })
    it(`${method} accepts the exact byte limit`, async () => {
      const { response } = streamed(max)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      const client = new WebDavClient(target)
      const result = await (method === 'list' ? client.list() : client.get('backup'))
      expect(result.length).toBe(method === 'get' ? max : 0)
      expect(response.body?.locked).toBe(false)
    })
  }

  it.each([['PUT', 201], ['PUT', 500], ['GET', 500], ['PROPFIND', 500]] as const)('cancels unused %s %s response bodies', async (method, status) => {
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { status })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    const client = new WebDavClient(target)
    const task = method === 'PUT' ? client.put('backup', new Uint8Array([1])) : method === 'GET' ? client.get('backup') : client.list()
    if (status === 201) await task
    else await expect(task).rejects.toThrow('WebDAV')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels initial PUT, every MKCOL and final PUT bodies without waiting for endless body cancellation', async () => {
    const cancels = Array.from({ length: 4 }, () => vi.fn(() => new Promise<void>(() => {})))
    const statuses = [409, 201, 405, 201]
    const fetch = vi.fn()
    for (let i = 0; i < cancels.length; i++) fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancels[i] }), { status: statuses[i] }))
    vi.stubGlobal('fetch', fetch)
    await new WebDavClient({ ...target, remoteDir: 'a/b' }).put('backup', new Uint8Array([1]))
    cancels.forEach(cancel => expect(cancel).toHaveBeenCalledTimes(1))
  })

  it('cancels a rejected MKCOL response and does not retry uploading', async () => {
    const cancels = [vi.fn(), vi.fn()], fetch = vi.fn()
    for (const [index, status] of [409, 403].entries()) fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancels[index] }), { status }))
    vi.stubGlobal('fetch', fetch)
    await expect(new WebDavClient(target).put('backup', new Uint8Array([1]))).rejects.toThrow('WebDAV 创建目录失败 (403)')
    expect(fetch).toHaveBeenCalledTimes(2)
    cancels.forEach(cancel => expect(cancel).toHaveBeenCalledTimes(1))
  })

  it('rejects an oversized upload before making any request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(new WebDavClient(target).put('backup', new Uint8Array(WEBDAV_BACKUP_MAX_BYTES + 1))).rejects.toThrow('backup.webdavBackupTooLarge')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('releases a late response delivered after cancellation without reading it', async () => {
    const controller = new AbortController(), cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }))
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = new WebDavClient(target, { signal: controller.signal }).get('backup')
    const rejected = expect(pending).rejects.toThrow('canceled')
    controller.abort(new Error('canceled')); finish(response)
    await rejected
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('aborts a stalled body and releases its reader', async () => {
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    const controller = new AbortController(), client = new WebDavClient(target, { signal: controller.signal })
    const downloading = client.get('backup'), rejected = expect(downloading).rejects.toThrow('canceled')
    await vi.waitFor(() => expect(response.body?.locked).toBe(true))
    controller.abort(new Error('canceled'))
    await rejected
    expect(cancel).toHaveBeenCalledTimes(1); expect(response.body?.locked).toBe(false)
  })

  it('cancels an oversized real HTTP stream without waiting for its end', async () => {
    let closed!: () => void
    const disconnected = new Promise<void>(resolve => { closed = resolve })
    const server = http.createServer((_request, response) => {
      response.writeHead(207, { 'Content-Type': 'application/xml' })
      response.write(Buffer.alloc(WEBDAV_LIST_MAX_BYTES + 1))
      response.on('close', closed)
      // Deliberately never end this response.
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
      const client = new WebDavClient({ ...target, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
      await expect(client.list()).rejects.toThrow('backup.webdavListTooLarge')
      await disconnected
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
