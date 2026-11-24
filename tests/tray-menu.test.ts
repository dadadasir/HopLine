import { expect, it } from 'vitest'
import { trayRows } from '../src/main/tray-menu'
import { parseCollect } from '../src/core/collect/parse'
import fs from 'node:fs'

it('uses only cached status for every host and never exposes endpoint or credentials', () => {
  const snapshot = parseCollect(fs.readFileSync(new URL('./fixtures/collect/alpine.txt', import.meta.url), 'utf8'), 123)
  const hosts = [{ id: 'one', name: '第一台', host: 'private-address', username: 'private-user' }, { id: 'two', name: '未检查' }, { id: 'three', name: '有\n换行&菜单' }]
  const rows = trayRows(hosts, { one: { snapshot, error: null, updatedAt: 123 }, three: { snapshot, error: 'secret-error', updatedAt: 123 } }, 'zh', 123)
  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatch(/^第一台 · /)
  expect(rows[1]).toBe('未检查 · 未采集')
  expect(rows[2]).toBe('有 换行 菜单 · 上次检查失败')
  expect(rows.join('\n')).not.toMatch(/private-address|private-user|secret-error/)
  expect(trayRows(hosts, {}, 'en')[0]).toBe('第一台 · Not collected')
})
it('does not turn missing numeric metrics into zero', () => {
  const snapshot = parseCollect('', 1)
  expect(trayRows([{ id: 'one', name: '机器' }], { one: { snapshot, error: null, updatedAt: 1 } }, 'zh', 1)).toEqual(['机器 · 数据不可用'])
})

it('labels expired and future-dated cached observations without presenting their old metrics as current', () => {
  const snapshot = parseCollect('', 1000)
  snapshot.cpu = { status: 'complete', data: { cores: 2, usagePercent: 17 } }
  const records = { one: { snapshot, error: null, updatedAt: 1000 } }, hosts = [{ id: 'one', name: '机器' }]
  expect(trayRows(hosts, records, 'zh', 1000)).toEqual(['机器 · CPU 17%'])
  expect(trayRows(hosts, records, 'zh', 601000)).toEqual(['机器 · 历史数据，待刷新'])
  expect(trayRows(hosts, records, 'en', 601000)).toEqual(['机器 · Stale data — refresh needed'])
  expect(trayRows(hosts, records, 'zh', -60000)).toEqual(['机器 · 历史数据，待刷新'])
})
