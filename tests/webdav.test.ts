import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePropfind, WebDavClient } from '../src/core/webdav'

afterEach(() => vi.unstubAllGlobals())

describe('WebDAV backup transport', () => {
  const client = new WebDavClient({ url: 'https://dav.test/root/', username: 'u', password: 'p', remoteDir: '/备份/daily/' })

  it('uploads to an existing directory with one PUT and no MKCOL', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    await client.put('backup', new Uint8Array([1]))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1].method).toBe('PUT')
  })

  it.each([404, 409])('creates collections only after PUT returns %s then retries once', async (status) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    const name = '20261027000000001.hopline-backup'
    await client.put(name, new Uint8Array([1]))
    expect(fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [client.fileUrl(name), 'PUT'],
      ['https://dav.test/root/%E5%A4%87%E4%BB%BD', 'MKCOL'],
      ['https://dav.test/root/%E5%A4%87%E4%BB%BD/daily', 'MKCOL'],
      [client.fileUrl(name), 'PUT']
    ])
    expect(fetch.mock.calls[3]?.[1].body).toEqual(Buffer.from([1]))
    expect(fetch.mock.calls.every(([, init]) => init.headers.Authorization === 'Basic dTpw')).toBe(true)
  })

  it('reports a Chinese error and stops when MKCOL fails', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    await expect(client.put('a', new Uint8Array())).rejects.toThrow('WebDAV 创建目录失败 (403)')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([403, 500])('reports PUT failure %s without creating directories', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    await expect(client.put('a', new Uint8Array())).rejects.toThrow(`WebDAV 上传失败 (${status})`)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry repeatedly when the second PUT still fails', async () => {
    const fetch = vi.fn().mockImplementation((_url, init) =>
      Promise.resolve(new Response(null, { status: init.method === 'PUT' ? 409 : 405 })))
    vi.stubGlobal('fetch', fetch)
    await expect(client.put('a', new Uint8Array())).rejects.toThrow('WebDAV 上传失败 (409)')
    expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual(['PUT', 'MKCOL', 'MKCOL', 'PUT'])
  })

  it('keeps malformed URL escapes without aborting the listing', () => {
    expect(parsePropfind('<d:response><d:href>/dav/%ZZ.hopline-backup</d:href></d:response>'))
      .toEqual([{ href: '/dav/%ZZ.hopline-backup', name: '%ZZ.hopline-backup', lastModified: undefined }])
  })
})
