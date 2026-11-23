import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { parseCollect } from '../src/core/collect/parse'
import type { CollectRecords, HostPublic } from '../src/shared/types'
import { setRendererCapabilities } from '../src/renderer/src/ext/capabilities'
import { Overview } from '../src/renderer/src/components/Overview'
import { getState, patch } from '../src/renderer/src/state/store'

const initial = getState(), now = Date.UTC(2026, 10, 11, 12)
const vault = new Vault(emptyStore(), new MemorySecretCodec())
const hosts = Array.from({ length: 8 }, (_, index) => vault.saveHost({
  name: `主机 ${index + 1}`, host: `127.0.0.${index + 1}`, port: 22, username: 'fixture', authType: 'agent', groupId: null,
  meta: { price: 1000, currency: 'USD', billingCycle: 'monthly', renewAt: index >= 5 ? now + 14 * 86400000 : null }
}))
function records(): CollectRecords {
  return Object.fromEntries(hosts.map((host, index) => {
    const snapshot = parseCollect('', now)
    for (const key of ['os', 'uptime', 'cpu', 'memory', 'load', 'disk', 'listeners', 'docker', 'services', 'web', 'certs'] as const) snapshot[key] = { status: 'unavailable', reason: 'not-installed' }
    snapshot.cpu = { status: 'complete', data: { cores: 2, usagePercent: 18 } }
    snapshot.disk = { status: 'complete', data: [{ filesystem: '/dev/vda1', mountpoint: '/', totalBytes: 1000, usedBytes: index >= 5 ? 997 : 100, availableBytes: index >= 5 ? 3 : 900, usagePercent: index >= 5 ? 99.7 : 10 }] }
    return [host.id, { snapshot, updatedAt: now, error: null }]
  }))
}
function render(list: HostPublic[] = hosts, snapshots = records(), locale: 'zh' | 'en' = 'zh') {
  patch({ hosts: list, snapshots, collecting: [], settings: { ...vault.settingsPublic(false), language: locale } })
  return renderToStaticMarkup(createElement(Overview))
}
function tile(html: string, label: string) {
  const value = html.match(new RegExp(`<p[^>]*>${label}</p><p[^>]*>([^<]+)</p>`))?.[1]
  expect(value, `Tile ${label} is present`).toBeDefined()
  return value
}
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); vi.stubGlobal('__HOPLINE_EDITION__', 'community'); setRendererCapabilities({ overviewHostLimit: 5 }) })
afterEach(() => { patch(() => initial); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([0, 1, 5])('shows no limited cards or upgrade copy for %i hosts', (count) => {
  const html = render(hosts.slice(0, count))
  expect(html.match(/<article\b/g) ?? []).toHaveLength(count)
  expect(html).not.toContain('data-overview-limited')
  expect(html).not.toContain('专业版即将推出')
  if (count) expect(tile(html, '运行正常')).toBe(`${count}/${count}`)
})

it('limits health and notices to the first five but includes all costs and renewals', () => {
  const snapshots = records(); snapshots[hosts[2].id] = { snapshot: null, updatedAt: null, error: null }
  const html = render(hosts, snapshots)
  expect(tile(html, '运行正常')).toBe('4/5')
  expect(tile(html, '需要处理')).toBe('—')
  expect(html).toContain('1 台待更新，点全部刷新')
  expect(html).toContain('状态未确认，不能判断')
  expect(tile(html, '每月费用')).toBe('¥533.38')
  expect(html).toContain('$80.00')
  expect(tile(html, '15 天内续费')).toBe('3')
  expect(html).not.toContain('99.7%')
  expect(html).not.toContain('磁盘使用率过高')
  expect(html.match(/<article\b/g)).toHaveLength(5)
  const limited = [...html.matchAll(/<button[^>]*data-overview-limited-host="([^"]+)"[^>]*>(.*?)<\/button>/g)]
  expect(limited.map(match => match[1])).toEqual(hosts.slice(5).map(host => host.id))
  for (const [index, match] of limited.entries()) {
    expect(match[2].replace(/<[^>]*>/g, '')).toBe(`${hosts[index + 5].name}${hosts[index + 5].host}`)
    expect(match[2]).not.toMatch(/<svg|<article|健康分|提醒|CPU|刷新/)
  }
  expect(html).toContain('总览自动更新前 5 台，其余主机可在详情页手动刷新。')
  expect(html).not.toMatch(/<a\b|购买|upgrade/i)
})

it('uses the supplied host order without sorting or selecting by snapshot availability', () => {
  const reordered = [...hosts].reverse(), snapshots = records()
  snapshots[reordered[0].id] = { snapshot: null, updatedAt: null, error: null }
  const html = render(reordered, snapshots)
  const cards = [...html.matchAll(/<article\b.*?<\/article>/g)].map(match => match[0])
  expect(cards).toHaveLength(5)
  cards.forEach((card, index) => expect(card).toContain(reordered[index].name))
  const limited = [...html.matchAll(/data-overview-limited-host="([^"]+)"/g)].map(match => match[1])
  expect(limited).toEqual(reordered.slice(5).map(host => host.id))
})

it('shows all pro hosts and their issues without an upgrade prompt', () => {
  vi.stubGlobal('__HOPLINE_EDITION__', 'pro')
  setRendererCapabilities({ overviewHostLimit: Infinity })
  const html = render()
  expect(html.match(/<article\b/g)).toHaveLength(8)
  expect(tile(html, '运行正常')).toBe('5/8')
  expect(tile(html, '需要处理')).toBe('3')
  expect(html).toContain('99.7%')
  expect(html).not.toContain('data-overview-limited')
  expect(html).not.toContain('专业版即将推出')
})

it('provides complete English limited-overview copy', () => {
  const html = render(hosts, records(), 'en')
  expect(html).toContain('Overview automatically updates the first 5 hosts.')
  expect(html).not.toContain('overview.limitExplanation')
  expect(tile(html, 'Healthy')).toBe('5/5')
  expect(tile(html, 'Renewals in 15 days')).toBe('3')
})

it.each(['missing', 'stale', 'failed'] as const)('does not present %s observations as a green zero-issue result', (kind) => {
  const snapshots = records(), host = hosts[0]
  if (kind === 'missing') delete snapshots[host.id]
  else if (kind === 'stale') snapshots[host.id].updatedAt = now - 11 * 60_000
  else if (kind === 'failed') snapshots[host.id].error = 'offline'
  else snapshots[host.id].snapshot!.cpu = { status: 'unavailable', reason: 'permission-denied' }
  for (const locale of ['zh', 'en'] as const) {
    const html = render([host], snapshots, locale)
    expect(tile(html, locale === 'zh' ? '需要处理' : 'Needs attention')).toBe('—')
    expect(html).toContain(locale === 'zh' ? '1 台待更新，点全部刷新' : '1 host to update. Select Refresh all.')
    expect(html).toContain('data-overview-unknown')
    expect(html).not.toContain('已采集的状态暂无已知问题')
  }
})

it('keeps known risk actionable while disclosing unknown hosts', () => {
  const snapshots = records(); delete snapshots[hosts[0].id]
  const html = render([hosts[0], hosts[7]], snapshots)
  expect(tile(html, '需要处理')).toBe('1')
  expect(html).toContain('1 台待更新，点全部刷新')
  expect(html).toContain('磁盘使用率过高')
})

it('separates an empty catalog from collected status with no issues', () => {
  expect(render([])).toContain('添加第一台主机')
  expect(render([])).not.toContain('暂无已知问题')
  const healthy = render([hosts[0]])
  expect(healthy).toContain('已采集的状态暂无已知问题')
  expect(tile(healthy, '需要处理')).toBe('0')
  expect(healthy).not.toContain('data-overview-unknown')
})
