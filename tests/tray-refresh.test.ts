import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { CollectRecords, HostPublic } from '../src/shared/types'
import { parseCollect } from '../src/core/collect/parse'

interface Item { label?: string; click?: () => void }
interface TestMenu extends EventEmitter { items: Item[] }
interface TestTray { menu?: TestMenu; destroy: () => void; isDestroyed: () => boolean }
const mocks = vi.hoisted(() => ({ trays: [] as TestTray[] }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Tray {
    menu?: TestMenu
    destroyed = false
    constructor() { mocks.trays.push(this) }
    setToolTip() {}
    setContextMenu(menu: TestMenu) { this.menu = menu }
    destroy() { this.destroyed = true }
    isDestroyed() { return this.destroyed }
  }
  const icon = { resize: () => icon, isEmpty: () => false, setTemplateImage() {} }
  return { Tray, nativeImage: { createFromPath: () => icon }, Menu: { buildFromTemplate(items: Item[]) { return Object.assign(new EventEmitter(), { items }) } } }
})
vi.mock('../src/main/assets/trayTemplate.png?asset', () => ({ default: '/fixture/tray.png' }))
vi.mock('../build/linux/icons/32.png?asset', () => ({ default: '/fixture/tray-color.png' }))
import { StatusTray } from '../src/main/tray'

afterEach(() => { mocks.trays.splice(0); vi.useRealTimers() })

it('recomputes cached age when the existing menu opens without a collection callback or timer', () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000)
  const snapshot = parseCollect('', Date.now())
  snapshot.cpu = { status: 'complete', data: { cores: 2, usagePercent: 17 } }
  let rows: CollectRecords = { one: { snapshot, updatedAt: Date.now(), error: null } }
  const records = vi.fn(() => rows), open = vi.fn(), quit = vi.fn()
  const tray = new StatusTray({ hosts: () => [{ id: 'one', name: '测试主机' }] as HostPublic[], records, language: () => 'zh', open, quit })
  tray.setEnabled(true)
  const menu = mocks.trays[0].menu!
  expect(menu.items[1].label).toBe('测试主机 · CPU 17%')
  vi.setSystemTime(Date.now() + 10 * 60_000)
  menu.emit('menu-will-show')
  expect(menu.items[1].label).toBe('测试主机 · 历史数据，待刷新')
  expect(records).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0)
  expect(open).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled()
  rows = {}; menu.emit('menu-will-show')
  expect(menu.items[1].label).toBe('测试主机 · 未采集')
  menu.items.at(-2)!.click!(); menu.items.at(-1)!.click!()
  expect(open).toHaveBeenCalledOnce(); expect(quit).toHaveBeenCalledOnce()
  tray.dispose(); expect(tray.active).toBe(false)
})
