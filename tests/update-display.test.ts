import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateDialog } from '../src/renderer/src/components/UpdateDialog'
import { checkForUpdates, updateAvailable } from '../src/renderer/src/state/updates'
import { getState, patch } from '../src/renderer/src/state/store'
import { translate } from '../src/renderer/src/i18n'

afterEach(() => { vi.unstubAllGlobals(); patch({ updateOpen: false, updateChecking: false, updateResult: null }) })
it('coalesces manual checks and preserves dismissal while the response is pending', async () => {
  let finish!: (value: { status: 'current' }) => void
  const check = vi.fn(() => new Promise<{ status: 'current' }>(resolve => { finish = resolve }))
  vi.stubGlobal('window', { hopline: { updates: { check } } })
  const pending = checkForUpdates()
  await checkForUpdates()
  expect(check).toHaveBeenCalledOnce()
  patch({ updateOpen: false })
  finish({ status: 'current' }); await pending
  expect(getState()).toMatchObject({ updateOpen: false, updateChecking: false, updateResult: { status: 'current' } })
})
it('handles IPC failure without showing raw error data', async () => {
  vi.stubGlobal('window', { hopline: { updates: { check: async () => { throw new Error('/private/profile user-data') } } } })
  await checkForUpdates()
  expect(getState().updateResult).toEqual({ status: 'error', reason: 'unavailable' })
})
it.each(['zh','en'] as const)('renders notes as inert text and translates errors and first-check labels (%s)', (locale) => {
  patch({ settings: { ...getState().settings!, language: locale } })
  updateAvailable({ version: '0.4.0', url: 'https://github.com/dadadasir/HopLine/releases/tag/v0.4.0', summary: '<img src=x onerror=alert(1)> [unsafe](http://evil.test)' })
  const html = renderToStaticMarkup(createElement(UpdateDialog))
  expect(html).not.toContain('<img')
  expect(html).not.toContain('href=')
  expect(html).toContain('&lt;img')
  expect(html).toContain(translate(locale, 'updates.openRelease'))
  for (const reason of ['network','timeout','invalid','unavailable','rate-limit','storage']) {
    const key = `updates.error.${reason}`, text = translate(locale, key)
    expect(text).not.toBe(key)
    expect(/[\u3400-\u9fff]/.test(text)).toBe(locale === 'zh')
  }
  expect(translate(locale, 'security.startCheck')).toBe(locale === 'zh' ? '开始检查' : 'Run check')
  expect(translate(locale, 'security.startSudo')).toBe(locale === 'zh' ? '用 sudo 检查' : 'Check with sudo')
})
