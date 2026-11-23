import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluate, securityScore } from '../src/core/security/rules'
import { parseSecurity } from '../src/core/security/parse'
import { healthScore } from '../src/core/health'
import { parseCollect } from '../src/core/collect/parse'
import { emptyHostMeta } from '../src/core/host-meta'
import { shareData, shareHTML } from '../src/core/security/share'
import { translate } from '../src/renderer/src/i18n'
import type { SecuritySnapshot } from '../src/core/security/types'
const now = Date.UTC(2026, 9, 27)
const fixture = fs.readFileSync(new URL('./fixtures/security/unsafe.txt', import.meta.url), 'utf8')
const unsafe = () => parseSecurity(fixture, now)
function safe(): SecuritySnapshot {
  return parseSecurity(fixture.replace('VERSION_ID="10"', 'VERSION_ID="12"').replace('permitrootlogin yes', 'permitrootlogin no')
    .replace('passwordauthentication yes', 'passwordauthentication no').replace('permitemptypasswords yes', 'permitemptypasswords no')
    .replace('port 22', 'port 2222').replace('Status: inactive', 'Status: active').replace('0.0.0.0:3306', '127.0.0.1:3306').replace('[::]:2375', '[::]:2376')
    .replace('auto=no', 'auto=yes').replace('Debian-Security:10/buster-security', 'Debian:10/buster').replace('reboot=yes', 'reboot=no')
    .replace('uid0=backup\n', '').replace('empty=guest\n', '').replace('xmrig /tmp/xmrig --donate-level 1', 'sleep sleep 100')
    .replace('Oct 28 10:20:30 2026', 'Oct 28 10:20:30 2027'), now)
}
const ids = evaluate(unsafe(), {}, now).map((r) => r.id)
describe.each(ids)('%s', (id) => {
  it('distinguishes pass, fail and unknown for every rule', () => {
    expect(evaluate(unsafe(), {}, now).find((r) => r.id === id)?.status).toBe('fail')
    expect(evaluate(safe(), {}, now).find((r) => r.id === id)?.status).toBe('pass')
    expect(evaluate(parseSecurity('', now), {}, now).find((r) => r.id === id)?.status).toBe('unknown')
  })
})
it('scores severity, ignores, default port and clamps to zero', () => {
  expect(securityScore(evaluate(unsafe(), {}, now))).toBe(0)
  const s = safe(); s.sshd = { status: 'complete', data: { port: '22', permitrootlogin: 'yes', passwordauthentication: 'no', permitemptypasswords: 'no' } }
  expect(securityScore(evaluate(s, {}, now))).toBe(80)
  expect(securityScore(evaluate(s, { 'ssh-root-login': { at: now, note: 'intentional' } }, now))).toBe(100)
  expect(securityScore(evaluate(parseSecurity('', now), {}, now))).toBe(100)
})
it('uses validated ports and usernames only, with lockout warnings first and no kill commands', () => {
  const s = unsafe(); s.sshd = { status: 'complete', data: { port: '2202', permitrootlogin: 'yes' } }
  expect(evaluate(s, {}, now).find((r) => r.id === 'firewall-off')?.fix?.commands).toContain('allow 2202/tcp')
  s.sshd.data.port = '22;$(touch /tmp/pwn)'; s.accounts = { status: 'complete', data: { uid0: ['root', '$(touch /tmp/pwn)'], empty: ['-root', 'x;evil', 'safe_user'] } }
  const result = evaluate(s, {}, now), commands = result.map((r) => r.fix?.commands ?? '').join('\n')
  expect(commands).not.toMatch(/touch|pwn|x;evil|'\-root'/)
  expect(commands).toContain("passwd -l 'safe_user'")
  expect(result.find((r) => r.id === 'firewall-off')?.fix?.commands).not.toContain('ufw enable')
  expect(result.find((r) => r.id === 'miner-process')?.fix?.commands).not.toMatch(/\bkill(?:all)?\b/)
  expect(result.find((r) => r.id === 'ssh-root-login')?.fix?.commands.split('\n')[0]).toBe('# security.command.ssh-first')
})
it('does not score unreadable shadow, partial SSH configuration, or unreferenced certificates', () => {
  const s = safe(); s.accounts = { status: 'complete', data: { uid0: ['root'], empty: null } }
  s.sshd = { status: 'partial', data: { passwordauthentication: 'yes', port: '22' }, note: 'Include/Match' }
  const rows = evaluate(s, {}, now)
  expect(rows.find((r) => r.id === 'empty-password-accounts')?.status).toBe('unknown')
  expect(rows.find((r) => r.id === 'ssh-password-auth')?.status).toBe('unknown')
  expect(rows.find((r) => r.id === 'tls-expiring')?.status).toBe('pass')
})
it.each([[59, 85], [60, 95], [79, 95], [80, 100]])('health incorporates security score %s', (value, score) => {
  const s = parseCollect('', now); s.securityScore = value
  expect(healthScore(s, emptyHostMeta(), now).score).toBe(score)
  expect(healthScore(s, emptyHostMeta(), now, { score: value }).score).toBe(score)
})
it('health ignores stale inventory certificates without positive reference evidence', () => {
  const s = parseCollect('', now)
  for (const unreferenced of [true, undefined, false]) {
    s.certs = { status: 'complete', data: [{ domain: 'unused', expiresAt: now - 1, unreferenced }] }
    expect(healthScore(s, emptyHostMeta(), now).score).toBe(unreferenced === false ? 75 : 100)
  }
})
it('share markup allowlists numeric summary and date, with no host evidence', () => {
  const snapshot = unsafe(), results = evaluate(snapshot, {}, now)
  const report = { snapshot, results, score: securityScore(results), ignores: { test: { at: now, note: 'private-host 192.0.2.1 secret.example.com' } } }
  const data = shareData(report)
  expect(Object.keys(data).sort()).toEqual(['checks', 'counts', 'date', 'score'])
  for (const locale of ['en', 'zh'] as const) {
    const html = shareHTML(data, (key) => translate(locale, key))
    expect(html).not.toMatch(/private|example.com|192\.0\.2\.1|backup|guest|xmrig|script/i)
    expect(html).toContain('HopLine')
  }
})
it.each([
  ['debian', '10', 'fail'], ['debian', '11', 'fail'], ['debian', '12', 'pass'], ['debian', '99', 'unknown'],
  ['ubuntu', '18.04', 'fail'], ['ubuntu', '20.04', 'fail'], ['ubuntu', '22.04', 'pass'], ['ubuntu', '19.04', 'unknown'],
  ['centos', '7', 'fail'], ['centos', '8', 'fail'], ['centos-stream', '8', 'fail'], ['alpine', '3.17.3', 'fail'],
  ['alpine', '3.20.2', 'fail'], ['alpine', '3.21.1', 'pass'], ['other', '1', 'unknown']
])('dates standard/community support for %s %s', (id, version, status) => {
  const s = safe(); s.os = { status: 'complete', data: { id, version, name: id, kernel: 'linux', architecture: 'x86_64' } }
  expect(evaluate(s, {}, now).find((r) => r.id === 'os-eol')?.status).toBe(status)
})
it('overview expiration counts omit old unreferenced certificates', async () => {
  const { cardCounts } = await import('../src/renderer/src/logic/overview')
  const snapshot = parseCollect('', now)
  snapshot.certs = { status: 'complete', data: [{ domain: 'unused', expiresAt: now - 1, unreferenced: true }] }
  expect(cardCounts(snapshot, now, 'en').find((r) => r.key === 'certs')?.text).toBe('Certificates 1')
})

it.each([[15, 'fail'], [16, 'pass']] as const)('uses the shared public TLS reminder boundary at day %s', (days, expected) => {
  const s = safe()
  s.tls = { status: 'complete', data: [{ domain: 'fixture.test', unreferenced: false, expiresAt: now + days * 86400000 }] }
  expect(evaluate(s, {}, now).find(row => row.id === 'tls-expiring')?.status).toBe(expected)
})
