import fs from 'node:fs'
import { expect, it } from 'vitest'
import { evaluate, securityScore } from '../src/core/security/rules'
import { parseSecurity } from '../src/core/security/parse'
import { maskHost, shareData, shareHTML } from '../src/core/security/share'
import { commandsText, evidenceText, securityRows } from '../src/renderer/src/logic/security'
import { translate } from '../src/renderer/src/i18n'

const now = Date.UTC(2026, 9, 27)
const snapshot = parseSecurity(fs.readFileSync(new URL('./fixtures/security/unsafe.txt', import.meta.url), 'utf8'), now)
const failed = evaluate(snapshot, {}, now), unknown = evaluate(parseSecurity('', now), {}, now)

it.each(['zh', 'en'] as const)('renders every failed, unknown and passed rule in %s without raw JSON or untranslated keys', (locale) => {
  expect(failed).toHaveLength(16)
  for (const result of [...failed, ...unknown, ...failed.map((r) => ({ ...r, status: 'pass' as const }))]) {
    const message = evidenceText(result, locale)
    expect(message.length).toBeGreaterThan(8)
    expect(message).not.toMatch(/[{}]|security\.|undefined|Incomplete or unavailable data/)
    if (locale === 'zh') expect(message).toMatch(/[\u4e00-\u9fff]/)
    else expect(message).not.toMatch(/[\u4e00-\u9fff]/)
  }
})

it('translates evidence parameters while preserving raw values and partial notes', () => {
  expect(evidenceText(failed.find((r) => r.id === 'db-exposed')!, 'zh')).toContain('3306（MySQL）')
  expect(evidenceText(failed.find((r) => r.id === 'auto-updates-off')!, 'zh')).toContain('未启用')
  expect(evidenceText(failed.find((r) => r.id === 'os-eol')!, 'zh')).toContain('标准／社区维护表日期：2026-10-27')
  expect(evidenceText(unknown.find((r) => r.id === 'security-updates-pending')!, 'zh')).toContain('安全更新查询失败、超时或不受支持')
  expect(JSON.parse(failed.find((r) => r.id === 'no-bruteforce-guard')!.evidence).params.raw).toBe('{"password":true,"guard":{"active":false}}')
  const partial = { ...snapshot, sshd: { status: 'partial' as const, data: { passwordauthentication: 'yes' }, note: 'Include/Match overrides' } }
  const result = evaluate(partial, {}, now).find((r) => r.id === 'ssh-password-auth')!
  expect(evidenceText(result, 'zh')).toContain('数据不完整或不可用')
  expect(evidenceText(result, 'zh')).not.toContain('Include/Match overrides')
  expect(JSON.parse(result.evidence).note).toContain('Include/Match overrides')
  expect(JSON.parse(result.evidence)).toMatchObject({ key: 'security.evidence.ssh-password-auth', params: { raw: 'yes', state: 'unknown' } })
})

it('reads legacy evidence and keeps the original diagnostic text intact', () => {
  const database = { ...failed.find((r) => r.id === 'db-exposed')!, evidence: '[{"port":3306},{"port":6379}]' }
  expect(evidenceText(database, 'zh')).toBe('对外监听：3306（MySQL）、6379（Redis）')
  const old = { ...unknown[0], evidence: 'Incomplete or unavailable data. permission-denied: raw note\nmore diagnostics' }
  const originalEvidence = old.evidence
  expect(evidenceText(old, 'zh')).not.toMatch(/Incomplete|permission-denied|raw note/)
  expect(old.evidence).toBe(originalEvidence)
  const os = { ...failed.find((r) => r.id === 'os-eol')!, evidence: 'debian 10; standard/community support table: 2026-10-27; paid ESM/ELTS not detected' }
  expect(evidenceText(os, 'zh')).toContain('debian 10 已超出标准维护期')
  expect(evidenceText(os, 'zh')).not.toContain('standard/community')
})

it('keeps ignored unknown evidence unknown and tolerates truncated legacy JSON', () => {
  const ignored = evaluate(parseSecurity('', now), { 'firewall-off': { at: now, note: '' } }, now).find((r) => r.id === 'firewall-off')!
  expect(ignored.status).toBe('ignored')
  expect(evidenceText(ignored, 'zh')).toContain('无法确认')
  expect(evidenceText({ ...failed[0], evidence: '{"broken":' }, 'zh')).not.toMatch(/[{}]/)
})

it('groups default SSH port only under hints and excludes it from all severity counts', () => {
  expect(securityRows(failed, 'hints').map((r) => r.id)).toEqual(['ssh-default-port'])
  for (const status of ['fail', 'unknown', 'pass', 'ignored'] as const) expect(securityRows(failed.map((r) => ({ ...r, status })), status).some((r) => r.id === 'ssh-default-port')).toBe(false)
  const data = shareData({ snapshot, results: failed, score: securityScore(failed), ignores: {} })
  expect(data.counts).toEqual([9, 4, 2])
  expect(securityRows(failed, 'fail').filter((r) => r.severity === 'low')).toHaveLength(2)
  const source = fs.readFileSync('src/renderer/src/components/SecurityDialog.tsx', 'utf8')
  expect(source).toContain("['fail', 'hints', 'unknown', 'pass', 'ignored']")
  expect(source).toContain("open={status === 'fail' || status === 'unknown'}")
})

it.each(['zh', 'en'] as const)('localizes command comments while preserving executable lines (%s)', (locale) => {
  for (const result of failed) {
    const commands = result.fix?.commands ?? '', localized = commandsText(commands, locale)
    expect(localized).not.toContain('security.command.')
    const executable = (text: string) => text.split('\n').filter((line) => !line.startsWith('# '))
    expect(executable(localized)).toEqual(executable(commands))
    if (locale === 'zh') for (const line of localized.split('\n').filter((line) => line.startsWith('# '))) expect(line).toMatch(/[\u4e00-\u9fff]/)
  }
  const first = commandsText(failed.find((r) => r.id === 'ssh-root-login')!.fix!.commands, locale).split('\n')[0]
  expect(first).toContain(locale === 'zh' ? '先验证其他账号和公钥登录' : 'FIRST')
  expect(commandsText('# Set passwordauthentication no; review Include and Match overrides.', 'zh')).toContain('设置 passwordauthentication no')
})

it.each(['zh', 'en'] as const)('keeps the share card private and resource-free (%s)', (locale) => {
  const results = failed.map((r) => ({ ...r, evidence: 'private-host 192.0.2.1 private.example.org' }))
  const data = shareData({ snapshot: { ...snapshot, collectedAt: new Date(2026, 9, 27, 12).getTime() }, results, score: 80, ignores: {} })
  const html = shareHTML(data, (key) => translate(locale, key))
  expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'")
  expect(html).not.toMatch(/private-host|192\.0\.2\.1|private\.example\.org|https?:|url\(|<script|<link|<img/)
  expect(html.match(/class="count"/g)).toHaveLength(3)
  expect(html).toContain(translate(locale, 'security.by'))
  expect(html).toContain('2026-10-27')
})

it.each([[80, '#5ed3a2'], [79, '#f2b862'], [60, '#f2b862'], [59, '#ff8f82']])('colors score %s at the specified thresholds', (score, color) => {
  expect(shareHTML({ score: Number(score), counts: [0, 0, 0], date: '2026-10-27' }, (key) => key)).toContain(`color:${color}`)
})

it('escapes translated share labels and rejects malformed dates and nonfinite counts', () => {
  const html = shareHTML({ score: Infinity, counts: [NaN, -2, 1.9], date: '<img src=x>' }, () => '<script>')
  expect(html).not.toMatch(/<script>|<img/)
  expect(html).toContain('&#60;script&#62;')
  expect(html).toContain('<strong>0</strong>')
  expect(html.match(/<b>0<\/b>/g)).toHaveLength(2)
  expect(html).toContain('<b>1</b>')
})


it('does not turn truncated lists into a false zero count', () => {
  const result = evaluate({ ...snapshot, processes: { status: 'complete', data: ['xmrig ' + 'x'.repeat(9000)] } }, {}, now).find((r) => r.id === 'miner-process')!
  expect(result.status).toBe('fail')
  expect(JSON.parse(result.evidence).params.raw).toHaveLength(8000)
  expect(evidenceText(result, 'zh')).toContain('检查结果过长或格式不完整')
  expect(evidenceText(result, 'en')).toContain('The finding is too long or incomplete')
})

it('shows only a masked address and per-area tallies on the share card', () => {
  expect(maskHost('203.0.113.120')).toBe('203.***.***.120')
  expect(maskHost('vps.example.org')).toBe('vp***.org')
  expect(maskHost('2001:db8::1')).toBe('2001:***:1')
  const data = shareData({ snapshot, results: failed, score: 40, ignores: {} }, '192.0.2.1')
  expect(data.host).toBe('192.***.***.1')
  expect(data.checks!.map((check) => check.key)).toEqual(['ssh', 'network', 'accounts', 'updates', 'processes', 'tls'])
  expect(data.checks!.reduce((sum, check) => sum + check.failed, 0)).toBe(data.counts.reduce((sum, count) => sum + count, 0))
  const html = shareHTML(data, (key) => translate('zh', key))
  expect(html).toContain('192.***.***.1')
  expect(html).not.toContain('192.0.2.1')
  expect(html).toContain('SSH 登录')
  expect(shareHTML({ ...data, host: '<img src=x>' }, (key) => key)).not.toContain('<img')
})

it.each(['zh', 'en'] as const)('never presents ignored checks as passed on the share card (%s)', (locale) => {
  const results = failed.map((result) => ({ ...result, status: 'ignored' as const }))
  const data = shareData({ snapshot, results, score: 100, ignores: {} })
  const html = shareHTML(data, (key) => translate(locale, key))
  expect(html).toContain(translate(locale, 'security.ignored'))
  expect(html).not.toContain('class="ok"')
  expect(html).not.toContain('>OK<')
  if (locale === 'zh') expect(html).not.toContain('no agent')
})

it('distinguishes mixed ignored, unknown and passed areas', () => {
  const results = failed.map((result) => ({ ...result, status: 'pass' as const }))
  const data = shareData({ snapshot, results, score: 100, ignores: {} })
  const checks = data.checks!.map((check, index) => index === 0 ? { ...check, ignored: 1 } : index === 1 ? { ...check, unknown: 1 } : check)
  const html = shareHTML({ ...data, checks }, (key) => translate('zh', key))
  expect(html).toContain('部分忽略')
  expect(html).toContain('待确认')
  expect(html).toContain('>通过</em>')
})


it.each(['zh', 'en'] as const)('does not direct malformed or unavailable evidence to a removed raw disclosure (%s)', (locale) => {
  for (const evidence of ['{"broken":', '[{"port":', 'Incomplete or unavailable data. permission-denied']) {
    const result = { ...failed[0], evidence }
    expect(evidenceText(result, locale)).not.toMatch(/原始数据|展开|raw data|expand/i)
    expect(result.evidence).toBe(evidence)
  }
  const source = fs.readFileSync('src/renderer/src/components/SecurityDialog.tsx', 'utf8')
  const translations = fs.readFileSync('src/renderer/src/i18n.ts', 'utf8')
  expect(source).not.toMatch(/RawEvidence|rawEvidenceText|security\.raw/)
  expect(translations).not.toContain("'security.raw'")
})
