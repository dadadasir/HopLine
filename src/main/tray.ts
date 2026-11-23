import { Menu, Tray, nativeImage } from 'electron'
import templatePath from './assets/trayTemplate.png?asset'
import colorPath from '../../build/linux/icons/32.png?asset'
import type { CollectRecords, HostPublic, Locale } from '../shared/types'
import { trayRows } from './tray-menu'

interface Options {
  hosts(): HostPublic[]
  records(): CollectRecords
  language(): Locale
  intervalMinutes?(): number
  open(): void
  quit(): void
}
/** Shared tray reads cached state only. Paid work is supplied by separate extensions. */
export class StatusTray {
  private tray: Tray | null = null
  constructor(private readonly options: Options) {}
  get active(): boolean { return !!this.tray && !this.tray.isDestroyed() }
  setEnabled(enabled: boolean): void {
    if (!enabled) { this.dispose(); return }
    if (!this.active) {
      const mac = process.platform === 'darwin'
      const win = process.platform === 'win32'
      const size = mac ? 18 : win ? 16 : 24
      const icon = nativeImage.createFromPath(mac ? templatePath : colorPath).resize({ width: size, height: size })
      if (icon.isEmpty()) throw new Error('菜单栏图标不可用 / Tray icon unavailable')
      if (mac) icon.setTemplateImage(true)
      this.tray = new Tray(icon)
      this.tray.setToolTip('HopLine')
      if (win) {
        this.tray.on('click', () => this.options.open())
        this.tray.on('double-click', () => this.options.open())
      }
    }
    this.refresh()
  }
  refresh(): void {
    if (!this.active) return
    const en = this.options.language() === 'en'
    const hosts = this.options.hosts(), rows = trayRows(hosts, this.options.records(), this.options.language(), Date.now(), this.options.intervalMinutes?.())
    const menu = Menu.buildFromTemplate([
      { label: en ? 'Last collected status · no tray polling' : '上次采集状态 · 托盘不自动采集', enabled: false },
      ...rows.map(label => ({ label, enabled: false })),
      ...(!rows.length ? [{ label: en ? 'No hosts' : '暂无主机', enabled: false }] : []),
      { type: 'separator' },
      { label: en ? 'Open main window' : '打开主窗口', click: () => this.options.open() },
      { label: en ? 'Quit' : '退出', click: () => this.options.quit() }
    ])
    // A quiet app can keep the same menu for hours. Recompute age when it opens,
    // using the cached rows only; opening the tray never starts collection.
    menu.on('menu-will-show', () => {
      const current = trayRows(hosts, this.options.records(), this.options.language(), Date.now(), this.options.intervalMinutes?.())
      current.forEach((label, index) => { menu.items[index + 1].label = label })
      // Linux tray implementations require reapplying changed MenuItems.
      if (process.platform === 'linux' && this.active) this.tray!.setContextMenu(menu)
    })
    this.tray!.setContextMenu(menu)
  }
  dispose(): void { this.tray?.destroy(); this.tray = null }
}
