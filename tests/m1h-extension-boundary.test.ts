import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionErrorBoundary } from '../src/renderer/src/ext/error-boundary'
afterEach(() => vi.restoreAllMocks())
it.each(['zh', 'en'] as const)('renders only the failed extension fallback in %s and logs the error', (locale) => {
  const child = createElement('span', null, 'extension')
  const boundary = new ExtensionErrorBoundary({ locale, children: child })
  expect(boundary.render()).toBe(child)
  boundary.state = ExtensionErrorBoundary.getDerivedStateFromError()
  const error = new Error('broken render')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  boundary.componentDidCatch(error)
  expect(log).toHaveBeenCalledWith('Extension render failed', error)
  expect(renderToStaticMarkup(boundary.render())).toContain(locale === 'zh' ? '扩展页面加载失败' : 'Extension page failed to load')
  expect(renderToStaticMarkup(boundary.render())).toContain('role="alert"')
  expect(new ExtensionErrorBoundary({ locale, children: child }).render()).toBe(child)
})
