import fs from 'node:fs'
import { expect, it } from 'vitest'
import { parseSecurity } from '../src/core/security/parse'
import { evaluate } from '../src/core/security/rules'
const section = (name: string, body: string) => `===HOPLINE:${name}===\n${body}\n\n#HOPLINE-END\n`
const parse = (name: string, body: string) => parseSecurity(section(name, body), 0)
it('parses effective sshd output and fallback first-value configuration without treating Match as global', () => {
  expect(parse('sshd', '#HOPLINE-SOURCE effective\npermitrootlogin yes\nport 2222').sshd).toEqual({ status: 'complete', data: { permitrootlogin: 'yes', port: '2222' } })
  expect(parse('sshd', '#HOPLINE-PARTIAL Include/Match unresolved\nPermitRootLogin no\nPermitRootLogin yes\nInclude snippets/*\nMatch User alice\nPasswordAuthentication yes').sshd).toMatchObject({ status: 'partial', data: { permitrootlogin: 'no' } })
})
it.each([
  ['ufw', 'Status: active', true], ['ufw', 'Status: inactive', false],
  ['firewall-cmd', 'running', true], ['firewall-cmd', 'not running', false],
  ['nft', 'table inet filter {\nchain input {\ntype filter hook input priority 0; policy drop;\n}\n}', true], ['nft', '', false],
  ['iptables', '-P INPUT ACCEPT\n-A INPUT -p tcp --dport 22 -j ACCEPT', true], ['iptables', '-P INPUT ACCEPT\n-P OUTPUT ACCEPT', false]
])('recognizes %s state from %s', (tool, raw, active) => {
  expect(parse('firewall', `#HOPLINE-SOURCE ${tool}\n${raw}`).firewall).toEqual({ status: 'complete', data: { active } })
})
it('counts apt security upgrades and dnf security advisories, never failed queries as zero', () => {
  const raw = fs.readFileSync(new URL('./fixtures/security/unsafe.txt', import.meta.url), 'utf8')
  expect(parseSecurity(raw, 0).updates).toMatchObject({ data: { pending: 1, auto: false, reboot: true } })
  expect(parse('updates', '#HOPLINE-SOURCE dnf\nRHSA-2026:0001 Important/Sec. openssl-1.x86_64\nRHBA-2026:1111 bugfix unrelated\npending-complete=yes\nauto=yes\nreboot=no').updates).toMatchObject({ data: { pending: 1, auto: true, reboot: false } })
  expect(parse('updates', '#HOPLINE-SOURCE apt\nInst foo (security)\nreboot=no').updates).toMatchObject({ data: { pending: null, auto: null } })
})
it('retains readable UID accounts when shadow is denied; never imports shadow hashes', () => {
  expect(parse('accounts', 'uid0=root\nshadow=permission-denied').accounts).toMatchObject({ data: { uid0: ['root'], empty: null } })
})
it('retains miner evidence, flags truncated output, and rejects garbage', () => {
  const s = parse('processes', ' PID USER %CPU COMMAND COMMAND\n 42 root 99.0 worker worker --donate-level 1')
  expect(evaluate(s).find((r) => r.id === 'miner-process')).toMatchObject({ status: 'fail', evidence: expect.stringContaining('--donate-level') })
  expect(parseSecurity(section('sshd', 'port 22').replace('#HOPLINE-END', ''), 0).sshd.status).toBe('unavailable')
  expect(parse('sshd', 'garbage').sshd.status).toBe('unavailable')
  expect(parse('processes', '').processes.status).toBe('unavailable')
})
it('parses referenced, served and orphan certificate blocks and keeps partial includes visible', () => {
  const s = parse('tls', '#HOPLINE-PARTIAL nginx configuration not expanded\n#HOPLINE-CERT referenced\nnotAfter=Jan 1 00:00:00 2027 GMT\nsubject=CN = one.example\n#HOPLINE-CERT served\nnotAfter=Jan 1 00:00:00 2028 GMT\nsubject=CN = two.example\n#HOPLINE-CERT unreferenced\nnotAfter=Jan 1 00:00:00 2020 GMT\nsubject=CN = orphan.example')
  expect(s.tls).toMatchObject({ status: 'partial', data: [{ domain: 'one.example', unreferenced: false }, { domain: 'two.example', unreferenced: false }, { domain: 'orphan.example', unreferenced: true }] })
})
it('parses yum security notices only after successful completion and never turns missing metadata into zero', () => {
  expect(parse('updates', '#HOPLINE-SOURCE yum\n  RHSA-2020:1234 Important/Sec. openssl-1.0.2k-19.el7.x86_64\nCESA-2020:5678 security kernel-3.10.0.x86_64\nRHBA-2020:0001 bugfix unrelated\npending-complete=yes\nauto=yes').updates).toMatchObject({ data: { auto: true, pending: 2 } })
  for (const output of ['', 'No packages needed for security; 0 packages available', 'Loaded plugins: fastestmirror']) {
    expect(parse('updates', `#HOPLINE-SOURCE yum\n${output}\npending-complete=yes`).updates).toMatchObject({ data: { pending: null, auto: null } })
  }
  expect(parse('updates', '#HOPLINE-SOURCE yum\nRHSA-2020:1234 Important/Sec. openssl\n#HOPLINE-PARTIAL 缓存不可用').updates).toMatchObject({ status: 'partial', data: { pending: null, auto: null } })
})
