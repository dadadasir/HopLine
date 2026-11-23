import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import { MemorySecretCodec, Vault, emptyStore } from '../src/core/vault'
import { parseCollect } from '../src/core/collect/parse'
import { HostCard } from '../src/renderer/src/components/HostCard'
import { HostStatus } from '../src/renderer/src/components/HostStatus'
import { Meter } from '../src/renderer/src/components/Gauge'
import { getState, patch } from '../src/renderer/src/state/store'
import { snapshotSectionKeys } from '../src/renderer/src/logic/host-workspace'
import type { CollectRecord } from '../src/shared/types'

const initial = getState(), now = Date.UTC(2026, 10, 11)
const host = new Vault(emptyStore(), new MemorySecretCodec()).saveHost({ name: '测试主机', groupId: null, host: '127.0.0.1', username: 'test', port: 22, authType: 'agent' })
const noop = () => {}
afterEach(() => patch(() => initial))
const renderCard = (record: CollectRecord) => renderToStaticMarkup(createElement(HostCard, {
  host, record, issues: [], busy: false, now, locale: 'zh', onOpen: noop, onRefresh: noop, onConnect: noop, onEdit: noop
}))

it('does not label incomplete collection healthy even when there are no known issues', () => {
  const snapshot = parseCollect('', now)
  snapshot.uptime = { status: 'complete', data: { seconds: 3600 } }
  snapshot.load = { status: 'complete', data: { one: 0.2, five: 0.1, fifteen: 0.1 } }
  const html = renderCard({ snapshot, updatedAt: now, error: null })
  expect(html).toContain('采集不可用')
  expect(html).not.toContain('运行正常')
  expect(html).toContain('已运行')
  expect(html).toContain('负载')
  expect(html).not.toMatch(/>[^<]*(?:up |load )/)
})

it('shows a collection error and retains muted historical metrics', () => {
  const snapshot = parseCollect('', now)
  snapshot.cpu = { status: 'complete', data: { cores: 2, usagePercent: 32 } }
  const html = renderCard({ snapshot, updatedAt: now, error: '暂时无法连接' })
  expect(html).toContain('暂时无法连接')
  expect(html).toContain('采集失败')
  expect(html).toContain('32%')
})

it('keeps unavailable swap usage unknown rather than presenting zero percent', () => {
  const snapshot = parseCollect('', now)
  snapshot.memory = { status: 'partial', data: { totalBytes: 4096, availableBytes: 2048, swapTotalBytes: 1024, swapUsedBytes: null } }
  const html = renderToStaticMarkup(createElement(HostStatus, { host, record: { snapshot, updatedAt: now, error: null }, issues: [], busy: false, now, locale: 'zh', onIssue: noop }))
  expect(html).not.toMatch(/>0%<\/span>/)
})

it('does not draw occupied space when the measured usage is zero', () => {
  expect(renderToStaticMarkup(createElement(Meter, { value: 0, tone: 'ok' }))).toContain('width:0%')
})

it('includes renewal risk in the displayed health score', () => {
  const snapshot = parseCollect('', now)
  for (const key of snapshotSectionKeys) snapshot[key] = { status: 'unavailable', reason: 'not-applicable' }
  const html = renderToStaticMarkup(createElement(HostCard, {
    host: { ...host, meta: { ...host.meta, renewAt: now } }, record: { snapshot, updatedAt: now, error: null },
    issues: [{ key: 'renew', level: 'bad', section: 'assets', title: '续费日期已到', detail: '' }],
    busy: false, now, locale: 'zh', onOpen: noop, onRefresh: noop, onConnect: noop, onEdit: noop
  }))
  expect(html).toContain('aria-label="健康分 80"')
  expect(html).toContain('1 项需要处理')
})
