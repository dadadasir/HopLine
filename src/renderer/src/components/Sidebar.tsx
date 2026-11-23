import { sshCommand } from '../../../core/connection-info'
import { orderedSelection, selectHosts } from '../logic/host-selection'
import { LayoutGrid } from 'lucide-react'
import { navigate, openHost } from '../state/navigation'
import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import * as Menu from '@radix-ui/react-context-menu'
import { Activity, MoreHorizontal, ChevronDown, ChevronRight, CircleHelp, FolderPlus, PanelLeft, Settings, Terminal, Import, Plus, Search } from 'lucide-react'
import type { HostGroup, HostPublic } from '@shared/types'
import { api, connectHost, patch, toast, reloadCatalog, toggleSidebar, shallowEqual, useAppSelector } from '../state'
import { errorText } from '../state'
import { IconButton, requestTextInput, useT } from './ui'
import { ExtensionSidebar } from '../ext/mounts'

function visibleHostOrder(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('aside [data-host-id]')].filter(element => element.getClientRects().length).map(element => element.dataset.hostId!)
}

const HostSelection = createContext<{ ids: string[]; select: (id: string, event: MouseEvent) => void; context: (id: string) => void; copySsh: (ids: string[]) => void }>({ ids: [], select: () => {}, context: () => {}, copySsh: () => {} })

export function Sidebar() {
  const route = useAppSelector((state) => state.route)
  const state = useAppSelector((current) => ({ hosts: current.hosts, groups: current.groups, tabs: current.tabs, activeId: current.activeId }), shallowEqual)
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const anchor = useRef<string | null>(null)
  const activeHostId = route.page === 'host' ? route.hostId : null
  useEffect(() => { setSelectedIds(activeHostId ? [activeHostId] : []); anchor.current = activeHostId }, [activeHostId])
  const t = useT(), en = useAppSelector(s => s.settings?.language === 'en')
  const hosts = state.hosts.filter(host => `${host.name} ${host.host} ${host.username} ${host.meta.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  const grouped = state.groups.map(group => ({ group, hosts: hosts.filter(host => host.groupId === group.id) })).filter(section => !query || section.hosts.length)
  const loose = hosts.filter(host => !host.groupId || !state.groups.some(group => group.id === host.groupId))
  const mac = window.hopline.platform === 'darwin'
  const selectedPage = route.page === 'billing' ? 'overview' : route.page
  const nav = (page: 'overview' | 'sessions' | 'activity' | 'settings' | 'help', label: string, icon: ReactNode, count?: number) => <button type="button" data-nav={page} aria-current={selectedPage === page ? 'page' : undefined} onClick={() => navigate({ page })} className={`nav-item ${selectedPage === page ? 'nav-selected' : ''}`}>
    {icon}<span className="flex-1">{label}</span>{count !== undefined && <span className="font-mono text-[11px] text-muted">{count}</span>}
  </button>
  const ids = selectedIds.filter(id => hosts.some(host => host.id === id))
  const selection = {
    ids,
    select: (id: string, event: MouseEvent) => {
      const order = visibleHostOrder()
      setSelectedIds(selectHosts(order, ids, anchor.current, id, event.shiftKey, event.metaKey || event.ctrlKey))
      if (!event.shiftKey) anchor.current = id
      if (!event.shiftKey && !event.metaKey && !event.ctrlKey) openHost(id)
    },
    context: (id: string) => { if (!ids.includes(id)) { setSelectedIds([id]); anchor.current = id } else setSelectedIds(orderedSelection(visibleHostOrder(), ids)) },
    copySsh: (values: string[]) => {
      const selected = orderedSelection(visibleHostOrder(), values).flatMap(id => state.hosts.find(host => host.id === id) ?? [])
      void api().clipboard.write(selected.map(sshCommand).join('\n')).then(() => toast(t('toast.copied'))).catch(error => toast(t(errorText(error)), 'err'))
    }
  }
  return <HostSelection.Provider value={selection}><aside aria-label={en ? 'Navigation' : '导航'} className="flex h-full w-[232px] shrink-0 flex-col border-r border-line bg-canvas">
    <div className={`app-drag flex h-12 shrink-0 items-center justify-between pr-2 ${mac ? 'pl-[78px]' : 'pl-4'}`}>
      <span className="text-[13px] font-semibold">HopLine</span>
      <IconButton label={en ? 'Collapse sidebar' : '收起侧栏'} onClick={toggleSidebar}><PanelLeft className="h-4 w-4" /></IconButton>
    </div>
    <div className="space-y-0.5 px-2">
      {nav('overview', t('overview.title'), <LayoutGrid className="h-4 w-4" />)}
      {nav('sessions', en ? 'Sessions' : '会话', <Terminal className="h-4 w-4" />, state.tabs.length)}
      {nav('activity', en ? 'Activity' : '活动', <Activity className="h-4 w-4" />)}
    </div>
    <div className="mt-4 flex items-center justify-between px-4 text-[12px] text-muted"><span>{en ? 'Hosts' : '主机'}</span><button type="button" className="flex items-center gap-1 text-accent" onClick={() => patch({ hostDialog: 'new' })}><Plus className="h-3.5 w-3.5" />{t('sidebar.new')}</button></div>
    <div className="relative mx-3 my-2"><Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted" /><input aria-label={t('sidebar.search')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('sidebar.search')} className="h-8 w-full pl-7 pr-2 text-[12px]" /></div>
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {!hosts.length && <p className="px-2 py-5 text-center text-[12px] text-muted">{t('sidebar.empty')}</p>}
      {grouped.map(section => <GroupSection key={section.group.id} group={section.group} hosts={section.hosts} />)}
      {!!loose.length && <section className="mt-3"><header className="px-2 pb-1 text-[11px] text-muted">{t('sidebar.ungrouped')}</header>{loose.map(host => <HostRow key={host.id} host={host} />)}</section>}
    </div>
    <div className="space-y-0.5 border-t border-line p-2">
      <button type="button" data-action="new-group" className="nav-item text-[12px]" onClick={() => requestTextInput({ title: t('sidebar.group'), submit: async name => { await api().groups.save({ name }); await reloadCatalog(); toast(t('toast.saved')) } })}><FolderPlus className="h-4 w-4" />{t('sidebar.group')}</button>
      <button type="button" className="nav-item text-[12px]" onClick={() => patch({ importSshConfigOpen: true })}><Import className="h-4 w-4" />{t('importSsh.title')}</button>
      {nav('settings', t('settings.title'), <Settings className="h-4 w-4" />)}
      {nav('help', en ? 'Help' : '帮助', <CircleHelp className="h-4 w-4" />)}
    </div>
    <ExtensionSidebar />
  </aside></HostSelection.Provider>
}

function GroupSection({ group, hosts }: { group: HostGroup; hosts: HostPublic[] }) {
  const t = useT(), en = useAppSelector(s => s.settings?.language === 'en')
  const [collapsed, setCollapsed] = useState(false)
  const actions = [
    { label: t('group.rename'), run: () => renameGroup(group, t('group.rename'), t('toast.saved')) },
    { label: t('group.up'), run: () => void api().groups.move(group.id, -1).catch(error => toast(errorText(error), 'err')) },
    { label: t('group.down'), run: () => void api().groups.move(group.id, 1).catch(error => toast(errorText(error), 'err')) },
    { label: t('group.delete'), run: () => patch({ confirm: { title: t('group.delete'), body: t('group.deleteBody', { name: group.name }), confirm: t('host.delete'), danger: true, run: async () => { await api().groups.delete(group.id); toast(t('toast.deleted')) } } }) }
  ]
  return <section className="mt-3">
    <div className="flex items-center gap-1">
      <button type="button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left text-[12px] text-muted">{collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}<span className="flex-1 truncate">{group.name}</span><span className="font-mono text-[11px]">{hosts.length}</span></button>
      <details className="relative"><summary aria-label={`${en ? 'Group actions' : '分组操作'} · ${group.name}`} className="cursor-pointer list-none rounded p-1 text-muted hover:bg-accent-soft"><MoreHorizontal className="h-4 w-4" /></summary><div className="absolute right-0 top-7 z-20 w-40 rounded-lg border border-line bg-panel p-1 shadow-lg">{actions.map(action => <button key={action.label} type="button" className="block w-full rounded px-2 py-2 text-left text-[12px] hover:bg-accent-soft" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); action.run() }}>{action.label}</button>)}</div></details>
    </div>
    {!collapsed && hosts.map(host => <HostRow key={host.id} host={host} />)}
  </section>
}

function HostRow({ host }: { host: HostPublic }) {
  const t = useT(), selection = useContext(HostSelection)
  const current = useAppSelector(state => state.route.page === 'host' && state.route.hostId === host.id)
  const selected = selection.ids.length ? selection.ids.includes(host.id) : current
  const copyIds = selection.ids.includes(host.id) ? selection.ids : [host.id]
  const live = useAppSelector(state => state.tabs.some(tab => tab.hostId === host.id && tab.status === 'connected'))
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <div onContextMenuCapture={() => selection.context(host.id)} className={`group flex items-center rounded-md ${selected ? 'bg-accent-soft' : 'hover:bg-black/5 dark:hover:bg-white/6'}`}>
          <button type="button" data-host-id={host.id} aria-current={current ? 'page' : undefined} aria-pressed={selected} onClick={event => selection.select(host.id, event)} title={`${host.username}@${host.host}:${host.port}`} className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-4 text-left text-[13px]">
            <span aria-label={live ? t('forward.running') : undefined} className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'bg-accent' : 'bg-muted/40'}`} />
            <span className="truncate">{host.name}</span>
          </button>
          <button type="button" aria-label={`${t('host.connect')} · ${host.name}`} title={t('host.connect')} onClick={() => void connectHost(host)} className="mr-1 rounded p-1.5 text-muted opacity-0 hover:text-accent focus:opacity-100 group-hover:opacity-100"><Terminal className="h-3.5 w-3.5" /></button>
        </div>
      </Menu.Trigger>
      <HostMenuContent>
        {copyIds.length > 1 ?
          <Menu.Item className={itemClass} onSelect={() => selection.copySsh(copyIds)}>{t('credentials.copySshMany', { count: copyIds.length })}</Menu.Item>
        : <>
        <Menu.Item className={itemClass} onSelect={() => void connectHost(host)}>{t('host.connect')}</Menu.Item>
        <Menu.Item className={itemClass} onSelect={() => patch({ hostDialog: host })}>{t('host.edit')}</Menu.Item>
        <Menu.Item className={itemClass} onSelect={() => selection.copySsh([host.id])}>{t('credentials.copySsh')}</Menu.Item>
        <Menu.Item
          className={itemClass}
          onSelect={() =>
            void api()
              .hosts.duplicate(host.id)
              .then(() => toast(t('toast.duplicated')))
              .catch((error) => toast(errorText(error), 'err'))
          }
        >
          {t('host.duplicate')}
        </Menu.Item>
        <Menu.Separator className="my-1 h-px bg-line" />
        <Menu.Item
          className={`${itemClass} text-red-600`}
          onSelect={() =>
            patch({
              confirm: {
                title: t('host.deleteTitle'),
                body: t('host.deleteBody', { name: host.name }),
                confirm: t('host.delete'),
                danger: true,
                run: async () => {
                  await api().hosts.delete(host.id)
                  toast(t('toast.deleted'))
                }
              }
            })
          }
        >
          {t('host.delete')}
        </Menu.Item>
        </>}
      </HostMenuContent>
    </Menu.Root>
  )
}

function HostMenuContent({ children }: { children: ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Content className="pop z-50 min-w-40 rounded-xl border border-line bg-panel p-1 text-[13px] shadow-[var(--shadow)]">
        {children}
      </Menu.Content>
    </Menu.Portal>
  )
}

const itemClass = 'cursor-default rounded-lg px-2 py-1.5 outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent'

function renameGroup(group: HostGroup, title: string, saved: string) {
  requestTextInput({ title, initialValue: group.name, submit: async name => {
    if (name === group.name) return
    await api().groups.save({ id: group.id, name })
    await reloadCatalog()
    toast(saved)
  } })
}
