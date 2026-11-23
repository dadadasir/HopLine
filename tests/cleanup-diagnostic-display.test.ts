import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import { CleanupDiagnosticCards } from '../src/renderer/src/components/CleanupDiagnosticCards'
import { getState, patch } from '../src/renderer/src/state/store'
import { parseCleanupDiagnostics, type CleanupDiagnostics } from '../src/core/cleanup/diagnostics'
const initial = getState()
afterEach(() => patch(() => initial))
const base = (): CleanupDiagnostics => ({ deleted: { status: 'available', data: { files: [], totalBytes: 0 } }, inodes: { status: 'available', data: [] }, logs: { status: 'available', data: [] } })
const render = (diagnostics: CleanupDiagnostics) => renderToStaticMarkup(createElement(CleanupDiagnosticCards, { diagnostics }))
it('shows findings only, with inode warning above 80 and risk above 95', () => {
  const data = base()
  data.inodes = { status: 'available', data: [80, 81, 95, 96].map(p => ({ mountpoint: `/disk${p}`, usagePercent: p, used: p, total: 100 })) }
  const html = render(data)
  expect(html).not.toContain('/disk80'); expect(html).toContain('/disk81'); expect(html).toContain('/disk95'); expect(html).toContain('/disk96')
  expect(html.match(/color:var\(--warn-fg\)/g)).toHaveLength(2)
  expect(html.match(/color:var\(--risk-fg\)/g)).toHaveLength(1)
  expect(render(base())).not.toContain('data-cleanup-diagnostic=')
})
it('unavailable sections explain why without inventing bytes or offering process actions', () => {
  const data = parseCleanupDiagnostics('')
  expect(render(data)).toContain('未取得这部分诊断结果')
  expect(render(data)).not.toContain('0 B')
  for (const language of ['zh', 'en'] as const) {
    patch({ settings: { ...initial.settings!, language } })
    const html = render(data)
    expect(html).not.toContain('cleanup.diagnostic.')
    expect(html).not.toContain('<button')
  }
})
