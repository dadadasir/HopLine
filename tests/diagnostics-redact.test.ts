import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }))
import { redact } from '../src/main/diagnostics'

const context = { values: ['ops', 'ops-production', 'ops-production.example.net', 'alice', '跳板一', 'a+b.example'], home: '/Users/example-fixture' }
describe('diagnostic redaction', () => {
  it('redacts known values longest first, including regex metacharacters and case variants', () => {
    expect(redact('ops-production.example.net ops-production ops alice 跳板一 a+b.example OPS', context))
      .toBe(Array(7).fill('[REDACTED]').join(' '))
  })
  it.each(['192.168.1.20', '10.2.3.4', '2001:db8::2', 'fe80::abcd%en0', '::ffff:192.0.2.9', '2001:db8:0:0:0:0:0:8', '::', '::2'])('redacts IP %s', (ip) => {
    expect(redact(`address=[${ip}] port 22`, context)).toBe('address=[[REDACTED]] port 22')
  })
  it('keeps loopback even when present in the host library', () => {
    expect(redact('127.0.0.1 ::1 22 连接超时', { ...context, values: ['127.0.0.1', '::1'] })).toBe('127.0.0.1 ::1 22 连接超时')
  })
  it('redacts emails, home directories, complete and truncated private keys, hex and base64 tokens', () => {
    const input = 'alice@example.net /Users/example-fixture/.ssh/id_ed25519\n-----BEGIN OPENSSH PRIVATE KEY-----\nshort secret\n-----END OPENSSH PRIVATE KEY-----\n' +
      'abcdef0123456789abcdef0123456789 ZGVhZGJlZWYwMTIzNDU2Nzg5YWJjZGVmZw==\n-----BEGIN RSA PRIVATE KEY-----\nunclosed secret'
    expect(redact(input, context)).toBe('[REDACTED] ~/.ssh/id_ed25519\n[REDACTED]\n[REDACTED] [REDACTED]\n[REDACTED]')
    expect(redact('C:\\Users\\Alice\\.ssh\\key', { values: ['Alice'], home: 'C:\\Users\\Alice' })).toBe('~\\.ssh\\key')
  })
  it('preserves ordinary diagnostic text and replaces long overlapping hostnames fully', () => {
    expect(redact('连接超时 port=22 durationMs=15000 2026-10-27T12:34:56.000Z', context))
      .toBe('连接超时 port=22 durationMs=15000 2026-10-27T12:34:56.000Z')
    const host = `${'a'.repeat(40)}.example.net`
    expect(redact(host, { values: [host, 'a'.repeat(40)], home: '' })).toBe('[REDACTED]')
  })
})
