import type { ReactNode } from 'react'
import type { RendererExtension as BaseExtension, Text } from '../../../ext/api'

export interface RendererExtension extends Omit<BaseExtension, 'settingsPages' | 'pages'> {
  pages?: { id: string; label: Text; render(): ReactNode }[]
  settingsPages?: { id: string; label: Text; render(): ReactNode }[]
}

export interface RendererRegistry {
  sidebarItems: NonNullable<RendererExtension['sidebarItems']>
  pages: NonNullable<RendererExtension['pages']>
  settingsPages: NonNullable<RendererExtension['settingsPages']>
  paletteActions: NonNullable<RendererExtension['paletteActions']>
  warnings: string[]
}

/** Pure merge: the loading boundary prints the returned diagnostics. First id wins. */
export function mergeRendererExtensions(extensions: readonly RendererExtension[]): RendererRegistry {
  const result: RendererRegistry = { sidebarItems: [], pages: [], settingsPages: [], paletteActions: [], warnings: [] }
  const ids = new Set<string>()
  const seen = { sidebarItems: new Set<string>(), pages: new Set<string>(), settingsPages: new Set<string>(), paletteActions: new Set<string>() }
  function append<T extends { id: string }>(items: readonly T[], target: T[], used: Set<string>, kind: string) {
    for (const item of items) {
      if (used.has(item.id)) result.warnings.push(`扩展项目 id 重复 / Duplicate ${kind} id: ${item.id}`)
      else { used.add(item.id); target.push(item) }
    }
  }
  for (const extension of extensions) {
    if (ids.has(extension.id)) {
      result.warnings.push(`扩展 id 重复 / Duplicate extension id: ${extension.id}`)
      continue
    }
    ids.add(extension.id)
    append(extension.sidebarItems ?? [], result.sidebarItems, seen.sidebarItems, 'sidebar')
    append(extension.pages ?? [], result.pages, seen.pages, 'pages')
    append(extension.settingsPages ?? [], result.settingsPages, seen.settingsPages, 'settings')
    append(extension.paletteActions ?? [], result.paletteActions, seen.paletteActions, 'palette')
  }
  return result
}

export function extensionPaletteActions(registry: RendererRegistry, locale: keyof Text, onError: (error: unknown) => void) {
  return registry.paletteActions.map((action) => ({
    id: `pro:${action.id}`,
    label: action.label[locale],
    keywords: action.keywords,
    run: () => { void Promise.resolve().then(() => action.run()).catch(onError) }
  }))
}
