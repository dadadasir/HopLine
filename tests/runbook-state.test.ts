import { afterEach, expect, it } from 'vitest'
import { getState, patch } from '../src/renderer/src/state/store'
import { openOpLog, openRunbook } from '../src/renderer/src/state/runbook'
import { timezoneRunbook } from '../src/core/runbook/samples'
import { translate } from '../src/renderer/src/i18n'
import { runbookError } from '../src/renderer/src/logic/runbook'

const initial = getState()
afterEach(() => patch(initial))
it('opens a host picker for the sample and accepts a specific host for reusable runbooks', () => {
  patch({ paletteOpen: true })
  openRunbook(timezoneRunbook)
  expect(getState()).toMatchObject({ paletteOpen: false, runbookTarget: { book: timezoneRunbook, hostId: '' } })
  openRunbook(timezoneRunbook, 'host')
  expect(getState().runbookTarget?.hostId).toBe('host')
  openOpLog('other')
  expect(getState().opLogHost).toBe('other')
})
it('provides both languages for statuses, summary, failures and rollback results', () => {
  for (const key of ['timezone', 'chooseHost', 'already', 'needed', 'unknown', 'executed', 'skipped', 'unavailable', 'failed', 'run', 'summary']) {
    expect(translate('zh', `runbook.${key}`)).not.toContain(`runbook.${key}`)
    expect(translate('en', `runbook.${key}`)).not.toContain(`runbook.${key}`)
  }
  expect(translate('en', 'sudo 密码不正确')).toBe('Incorrect sudo password')
  expect(translate('en', '回滚失败')).toBe('Rollback failed')
  expect(translate('en', runbookError(new Error("Error invoking remote method 'runbook:run': Error: sudo 密码不正确")))).toBe('Incorrect sudo password')
})

it('normalizes Electron AbortError prefixes so cancellation messages are translated', () => {
  const error = new Error("Error invoking remote method 'cleanup:du': AbortError: cleanup.readOnlyCanceled")
  expect(translate('zh', runbookError(error))).toBe('本次只读检查已取消')
  expect(translate('en', runbookError(error))).toBe('This read-only check was canceled')
})
