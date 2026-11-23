import { errorText, patch, toast, useAppSelector } from '../state'
import { useRendererExtensions } from './index'
import { ExtensionErrorBoundary } from './error-boundary'
import { extensionPaletteActions } from './registry'

function useExtensionLocale() {
  return useAppSelector((state) => state.settings?.language ?? 'zh')
}

export function ExtensionSidebar() {
  const rendererExtensions = useRendererExtensions()
  const locale = useExtensionLocale()
  if (!rendererExtensions.sidebarItems.length) return null
  return (
    <div className="space-y-1 border-t border-line px-2 py-2">
      {rendererExtensions.sidebarItems.map((item) => (
        <button key={item.id} type="button" onClick={() => {
          try { item.open() } catch (error) { toast(errorText(error), 'err') }
        }} className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-black/5 dark:hover:bg-white/8">
          {item.icon && <span aria-hidden>{item.icon}</span>}
          {item.label[locale]}
        </button>
      ))}
    </div>
  )
}

export function ExtensionSettingsTabs({ page, onSelect }: { page: string; onSelect?: (page: `pro:${string}`) => void }) {
  const rendererExtensions = useRendererExtensions()
  const locale = useExtensionLocale()
  return rendererExtensions.settingsPages.map((item) => (
    <button key={item.id} type="button" onClick={() => onSelect ? onSelect(`pro:${item.id}`) : patch({ settingsOpen: `pro:${item.id}` })}
      className={`block w-full rounded-lg px-2 py-1.5 text-left text-[13px] ${page === `pro:${item.id}` ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-black/5 dark:hover:bg-white/6'}`}>
      {item.label[locale]}
    </button>
  ))
}

export function ExtensionSettingsPage({ page }: { page: string }) {
  const rendererExtensions = useRendererExtensions()
  const locale = useExtensionLocale()
  const item = rendererExtensions.settingsPages.find((item) => page === `pro:${item.id}`)
  return item ? <ExtensionErrorBoundary key={item.id} locale={locale}>
    <ExtensionPage render={item.render} />
  </ExtensionErrorBoundary> : null
}

function ExtensionPage({ render }: { render: () => import('react').ReactNode }) {
  return render()
}

export function useExtensionPaletteActions() {
  const rendererExtensions = useRendererExtensions()
  const locale = useExtensionLocale()
  return extensionPaletteActions(rendererExtensions, locale, (error) => toast(errorText(error), 'err'))
}

export function ExtensionWorkspace({ id }: { id: string }) {
  const extensions = useRendererExtensions(), locale = useExtensionLocale()
  const item = extensions.pages.find(item => item.id === id)
  return item ? <ExtensionErrorBoundary key={id} locale={locale}><ExtensionPage render={item.render} /></ExtensionErrorBoundary>
    : <p className="p-6 text-muted">{locale === 'zh' ? '此页面暂不可用' : 'This page is unavailable'}</p>
}
export function useExtensionPageTitle(id: string | undefined): string {
  const extensions = useRendererExtensions(), locale = useExtensionLocale()
  return extensions.pages.find(item => item.id === id)?.label[locale] ?? (locale === 'zh' ? '扩展' : 'Extension')
}
