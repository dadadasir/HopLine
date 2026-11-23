import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import { CleanupReady, CleanupResults, CleanupConfirmation } from '../src/renderer/src/components/CleanupViews'
import { cleanupEmpty, cleanupIncompleteReason, cleanupSelectable } from '../src/renderer/src/logic/cleanup'
import { cleanupRunbook } from '../src/core/runbook/cleanup'
import type { RunbookPreview } from '../src/shared/types'
import type { StepResult } from '../src/core/runbook/types'
import { getState, patch } from '../src/renderer/src/state/store'
import { openCleanup } from '../src/renderer/src/state/runbook'
import { translate } from '../src/renderer/src/i18n'

const initial = getState()
afterEach(() => patch(() => initial))
const plan: RunbookPreview = { id: 'preview', sudo: 'root', steps: cleanupRunbook.steps.map(step => ({ id: step.id, status: step.id === 'tmp-old' ? 'unknown' : 'needed', reason: '', command: step.apply })), cleanup: Object.fromEntries(cleanupRunbook.steps.map(step => [step.id, { bytes: step.id === 'tmp-old' ? null : step.id === 'apk-cache' ? 0 : 1024, details: '', unavailable: step.id === 'dnf-cache' }])) }
const result = (stepId: string, status: StepResult['status'], reason = ''): StepResult => ({ stepId, title: '', status, reason, durationMs: 1, output: '' })
it('bulk selection excludes unknown, unsupported and empty items without weakening runbook eligibility', () => {
  expect(cleanupSelectable(plan)).not.toContain('tmp-old')
  expect(cleanupSelectable(plan)).not.toContain('dnf-cache')
  expect(cleanupSelectable(plan)).not.toContain('apk-cache')
  expect(cleanupEmpty(plan, 'tmp-old')).toBe(false)
  const html = renderToStaticMarkup(createElement(CleanupReady, { plan, selected: ['docker-build-cache'], onSelect: () => {}, mountSelector: null }))
  expect(html).toContain('aria-checked="mixed"')
  expect(html).toMatch(/aria-label="旧临时文件"[^>]*disabled/)
  expect(html).toContain('无法估算')
  expect(html).toContain('另有 2 项没有可清理的内容')
  expect(html).not.toContain('已满足')
})
it('results sum actual selected measurements including partial releases, not estimates or mount deltas', () => {
  const html = renderToStaticMarkup(createElement(CleanupResults, { selected: ['apt-cache', 'coredumps', 'journal'], results: { 'apt-cache': result('apt-cache', 'executed'), coredumps: result('coredumps', 'failed', '验证失败'), journal: result('journal', 'skipped', '前序步骤失败，已停止') }, changes: { 'apt-cache': { before: 4096, after: 1024 }, coredumps: { before: 2048, after: 1024 }, irrelevant: { before: 99999999, after: 0 } } }))
  expect(html.replace(/<[^>]+>/g, '')).toContain('已释放 4.0 KB')
  expect(html).toContain('data-cleanup-completed="coredumps"')
  expect(html).toContain('2 项未完成')
  expect(html).toContain('前一项未能完成')
  for (const word of ['已执行', '已满足', '已跳过', '不可用', 'cleanup.ui.']) expect(html).not.toContain(word)
})
it('unmeasured results are never reported as zero and no incomplete block appears for success', () => {
  const html = renderToStaticMarkup(createElement(CleanupResults, { selected: ['apt-cache'], results: { 'apt-cache': result('apt-cache', 'executed') }, changes: {} }))
  expect(html).toContain('未能测量'); expect(html).not.toContain('0 B'); expect(html).not.toContain('data-cleanup-incomplete')
  expect(cleanupIncompleteReason(result('apt-cache', 'skipped', '已取消'))).toBe('cleanup.ui.reason.stopped')
})
it('confirmation lists only the selected attention items in both languages', () => {
  for (const language of ['zh', 'en'] as const) {
    patch({ settings: { ...initial.settings!, language } })
    const html = renderToStaticMarkup(createElement(CleanupConfirmation, { plan, selected: ['apt-cache', 'rotated-logs'], onClose: () => {}, onRun: () => {} }))
    expect(html).toContain(translate(language, 'cleanup.ui.effect.rotated-logs'))
    expect(html).not.toContain(translate(language, 'cleanup.ui.effect.old-kernels'))
    expect(html).not.toContain('cleanup.ui.')
    for (const step of cleanupRunbook.steps) for (const key of ['name', 'effect']) expect(translate(language, `cleanup.ui.${key}.${step.id}`)).not.toBe(`cleanup.ui.${key}.${step.id}`)
  }
})
it('reopening a hidden workflow preserves its owner instead of unmounting an active run', () => {
  patch({ cleanupHost: 'first', cleanupHidden: true })
  openCleanup('second')
  expect(getState()).toMatchObject({ cleanupHost: 'first', cleanupHidden: false })
})
