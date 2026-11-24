import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCollect } from '../src/core/collect/parse'
import { emptyHostMeta } from '../src/core/host-meta'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { assetInput, cardCounts, dateInput, highestDisk, money, sectionNote, updatedAgo } from '../src/renderer/src/logic/overview'
import { overviewAction, paletteItems } from '../src/renderer/src/logic/palette'

const now = Date.UTC(2026, 9, 27), day = 86_400_000
const snapshot = () => parseCollect(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/collect/services.txt'), 'utf8'), now)

describe('overview display logic', () => {
  it('chooses the highest disk without sorting/mutating the source, including partial sections', () => {
    const a = { filesystem: '/dev/a', mountpoint: '/', totalBytes: 100, usedBytes: 20, availableBytes: 80, usagePercent: 20 }
    const b = { ...a, usagePercent: 95 }, c = { ...a, usagePercent: 50 }
    const disks = [a, b, c]
    expect(highestDisk({ status: 'partial', data: disks })).toBe(b)
    expect(disks).toEqual([a, b, c])
    expect(highestDisk({ status: 'complete', data: [] })).toBeNull()
    expect(highestDisk({ status: 'unavailable', reason: 'error' })).toBeNull()
  })
  it('separates expired certificates from those expiring within the inclusive 15-day window', () => {
    const s = snapshot()
    s.certs = { status: 'complete', data: [-day, 0, 7 * day, 15 * day, 16 * day].map((offset) => ({ domain: 'a', unreferenced: false, expiresAt: now + offset })) }
    expect(cardCounts(s, now, 'zh').map((row) => row.text)).toEqual(['容器 1', '服务 2', '站点 6', '证书 5 (2 张已过期，2 张 15 天内到期)'])
    expect(cardCounts(s, now, 'en')[3].text).toBe('Certificates 5 (2 expired, 2 expire within 15 days)')
    s.certs = { status: 'complete', data: [{ domain: 'a', unreferenced: false, expiresAt: now + 7 * day }] }
    expect(cardCounts(s, now, 'zh')[3].text).toBe('证书 1 (1 张 15 天内到期)')
  })
  it('distinguishes zero entries, unavailable counts, partial coverage and uncollected hosts', () => {
    const s = snapshot()
    s.docker = { status: 'unavailable', reason: 'permission-denied', note: 'sudo required' }
    s.services = { status: 'partial', data: [], note: 'truncated' }
    const counts = cardCounts(s, now, 'zh')
    expect(counts[0]).toMatchObject({ text: '容器（无权限）', note: '权限不足 · sudo required' })
    expect(counts[1]).toMatchObject({ text: '服务 0', note: '部分数据不可用 · truncated' })
    expect(cardCounts(null, now, 'zh').every((row) => row.text.endsWith('—') && row.note === '未采集')).toBe(true)
    expect(sectionNote({ status: 'unavailable', reason: 'not-installed' }, 'en')).toBe('Not installed')
  })
  it.each([[null, '未采集'], [now, '刚刚更新'], [now - 59_999, '刚刚更新'], [now - 60_000, '1 分钟前更新'], [now - 3_600_000, '60 分钟前更新'], [now + day, '刚刚更新']] as const)('formats update time %s', (timestamp, expected) => {
    expect(updatedAgo(timestamp, now, 'zh')).toBe(expected)
  })
  it('uses the immediate update label in English for the first minute', () => {
    expect(updatedAgo(now - 59_999, now, 'en')).toBe('Just now')
    expect(updatedAgo(now - 60_000, now, 'en')).toBe('Updated 1 minute ago')
  })
  it('uses each currency default decimals while keeping integer-price /100 units', () => {
    expect(money(451, 'EUR', 'en')).toBe('€4.51')
    expect(money(451, 'JPY', 'en')).toBe('¥5')
    expect(money(451 / 12, 'USD', 'en')).toBe('$0.38')
  })
  it('adds a palette action searchable in either language', () => {
    const action = overviewAction('打开总览', () => {})
    expect(paletteItems([], [action], 'overview')[0]).toMatchObject({ kind: 'action', id: 'action:overview' })
  })
})

describe('asset editing', () => {
  const fields = { provider: 'VPS', price: '4.51', currency: 'eur', billingCycle: 'monthly', renewAt: '2027-03-05', tags: ' a, b, a, ', note: 'hello' }
  function fixture() {
    const vault = new Vault(emptyStore(), new MemorySecretCodec())
    const host = vault.saveHost({
      groupId: null, name: 'existing', host: '127.0.0.1', port: 2222, username: 'hop', authType: 'password', password: 'secret',
      privateKey: 'private-key', passphrase: 'pass', privateKeyPath: '/key', startupCommand: 'pwd',
      proxy: { type: 'socks5', host: 'proxy', port: 1080, username: 'proxy-user', password: 'proxy-secret' },
      jumps: [{ host: 'jump', port: 22, username: 'jump-user', authType: 'password', password: 'jump-secret', privateKey: 'jump-key', passphrase: 'jump-pass' }]
    })
    return { vault, host }
  }
  it('saves minor units, normalizes tags, and preserves every connection field and stored secret', () => {
    const { vault, host } = fixture(), secrets = vault.secretsOf(host.id)
    const input = assetInput(host, fields), saved = vault.saveHost(input)
    expect(input.meta).toMatchObject({ price: 451, currency: 'EUR', tags: ['a', 'b'], provider: 'VPS', note: 'hello' })
    expect(dateInput(saved.meta.renewAt)).toBe('2027-03-05')
    expect(vault.secretsOf(host.id)).toEqual(secrets)
    for (const key of ['id', 'groupId', 'name', 'host', 'port', 'username', 'authType', 'privateKeyPath', 'proxy', 'jumps', 'agent', 'startupCommand'] as const) expect(saved[key]).toEqual(host[key])
  })
  it('preserves agent settings', () => {
    const { vault, host } = fixture()
    const agent = { socket: '/agent.sock', identityFile: '/public-key', forward: true }
    const updated = vault.saveHost({ ...host, authType: 'agent', agent })
    expect(vault.saveHost(assetInput(updated, fields)).agent).toEqual(agent)
  })
  it('clears optional fields and preserves zero as a valid amount', () => {
    const { host } = fixture(), empty = Object.fromEntries(Object.keys(fields).map((key) => [key, '']))
    expect(assetInput(host, empty).meta).toEqual(emptyHostMeta())
    expect(() => assetInput(host, { ...empty, price: '0' })).toThrow('同时填写币种和计费周期')
    expect(assetInput(host, { ...empty, price: '0', currency: 'USD', billingCycle: 'monthly' }).meta?.price).toBe(0)
    expect(dateInput(null)).toBe('')
  })
  it.each([
    ['price', 'bad', '价格必须是 0 到 1000000000 的整数'],
    ['price', '-0.001', '价格必须是 0 到 1000000000 的整数'],
    ['price', '10000000.01', '价格必须是 0 到 1000000000 的整数'],
    ['currency', 'EU', '币种必须是有效的 ISO 货币代码'],
    ['provider', 'x'.repeat(41), '厂商必须是不超过 40 字符的文本'],
    ['note', 'x'.repeat(2001), '备注必须是不超过 2000 字符的文本'],
    ['tags', 'x'.repeat(25), '每个标签最长 24 字符'],
    ['renewAt', 'invalid', '续费日期必须使用有效的 YYYY-MM-DD 日期'],
    ['renewAt', '2026-02-31', '续费日期必须使用有效的 YYYY-MM-DD 日期'],
    ['billingCycle', 'weekly', '计费周期不正确']
  ])('reuses metadata validation for %s', (key, value, message) => {
    expect(() => assetInput(fixture().host, { ...fields, [key]: value })).toThrow(message)
  })
})

describe('detail table formatting', () => {
  it('turns bytes, durations, percentages and dates into readable text', async () => {
    const { formatCell } = await import('../src/renderer/src/logic/overview')
    expect(formatCell('totalBytes', 1102221312, 'zh')).toBe('1.0 GB')
    expect(formatCell('swapUsedBytes', 782295040, 'en')).toBe('746 MB')
    expect(formatCell('availableBytes', 512, 'zh')).toBe('512 B')
    expect(formatCell('seconds', 29996222.32, 'zh')).toBe('347 天 4 小时')
    expect(formatCell('seconds', 3_700, 'en')).toBe('1h 1m')
    expect(formatCell('usagePercent', 55, 'zh')).toBe('55%')
    expect(formatCell('expiresAt', Date.parse('2026-09-01T12:00:00Z'), 'zh')).toBe('2026-09-01')
    expect(formatCell('name', null, 'zh')).toBe('—')
    expect(formatCell('port', 22, 'zh')).toBe('22')
  })
})


it.each([
  ['not-installed', '未安装', 'Not installed'], ['permission-denied', '无权限', 'No permission'],
  ['not-applicable', '不适用', 'Not applicable'], ['error', '采集失败', 'Unavailable']
] as const)('shows unavailable reason %s inline while keeping the full tooltip', (reason, zh, en) => {
  const s = snapshot()
  for (const key of ['docker', 'services', 'web', 'certs'] as const) s[key] = { status: 'unavailable', reason, note: 'Full diagnostic detail' }
  for (const [locale, label] of [['zh', zh], ['en', en]] as const) {
    for (const count of cardCounts(s, now, locale)) {
      expect(count.text).toContain(locale === 'zh' ? `（${label}）` : `(${label})`)
      expect(count.text).not.toContain('—')
      expect(count.note).toContain('Full diagnostic detail')
      expect(count.text).not.toContain('Full diagnostic detail')
    }
  }
})
