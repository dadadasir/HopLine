import { describe, expect, it } from 'vitest'
import { hexSha256ToOpenSsh } from '../src/core/fingerprint'
import { judgeHostKey, rememberHostKey } from '../src/core/known-hosts'
import { joinUrl, parsePropfind } from '../src/core/webdav'
import { S3CompatibleStub } from '../src/core/s3'

describe('known hosts and sync helpers', () => {
  it('formats an OpenSSH SHA256 fingerprint and tracks trust', () => {
    const fingerprint = hexSha256ToOpenSsh('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(fingerprint).toBe('SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU')
    expect(judgeHostKey([], '10.0.0.1', 22, fingerprint)).toBe('unknown')
    const saved = rememberHostKey([], { host: '10.0.0.1', port: 22, fingerprint, addedAt: 1 })
    expect(judgeHostKey(saved, '10.0.0.1', 22, fingerprint)).toBe('trusted')
    expect(judgeHostKey(saved, '10.0.0.1', 2222, fingerprint)).toBe('unknown')
    expect(judgeHostKey(saved, '10.0.0.1', 22, 'SHA256:different')).toBe('mismatch')
    const replaced = rememberHostKey(saved, {
      host: '10.0.0.1',
      port: 22,
      fingerprint: 'SHA256:different',
      addedAt: 2
    })
    expect(replaced).toHaveLength(1)
    expect(judgeHostKey(replaced, '10.0.0.1', 22, 'SHA256:different')).toBe('trusted')
  })

  it('joins WebDAV paths, parses PROPFIND, and keeps S3 as a stub', async () => {
    expect(joinUrl('https://dav.example.test/remote.php/dav/', 'hopline', 'a b.hopline-backup')).toBe(
      'https://dav.example.test/remote.php/dav/hopline/a%20b.hopline-backup'
    )
    const entries = parsePropfind(`<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/remote.php/dav/hopline/</d:href></d:response>
        <d:response>
          <d:href>/remote.php/dav/hopline/20261026.hopline-backup</d:href>
          <d:propstat><d:prop><d:getlastmodified>Mon, 26 Oct 2026 00:00:00 GMT</d:getlastmodified></d:prop></d:propstat>
        </d:response>
      </d:multistatus>`)
    expect(entries.map((entry) => entry.name)).toEqual(['hopline', '20261026.hopline-backup'])
    expect(entries[1]?.lastModified).toContain('2026')
    const s3 = new S3CompatibleStub({
      endpoint: 'https://s3.example.test',
      bucket: 'backups',
      region: 'auto',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      prefix: 'hopline',
      forcePathStyle: true
    })
    expect(s3.describe()).toContain('backups')
    await expect(s3.put('vault.hopline-backup', new Uint8Array())).rejects.toThrow(/尚未实现/)
    await expect(s3.list('hopline/')).rejects.toThrow(/尚未实现/)
  })
})
