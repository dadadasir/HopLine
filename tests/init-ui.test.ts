import fs from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { getState, patch } from '../src/renderer/src/state/store'
import { openInit } from '../src/renderer/src/state/runbook'
import { translate } from '../src/renderer/src/i18n'
import { initRunbook } from '../src/core/runbook/init'
const initial = getState()
afterEach(() => { patch({ ...initial, initHost: null }) })
it('opens the wizard for the selected host and closes the palette', () => {
  patch({ paletteOpen: true }); openInit('host')
  expect(getState()).toMatchObject({ initHost: 'host', paletteOpen: false })
})
it('has Chinese and English translations for every wizard label and runbook step', () => {
  const source = fs.readFileSync('src/renderer/src/components/InitWizard.tsx', 'utf8')
  const keys = [...source.matchAll(/'((?:init\.)[^']+)'/g)].map((match) => match[1])
  for (const key of [...keys, ...initRunbook.steps.map((step) => step.title), 'init.rule1', 'init.rule2', 'init.page1', 'init.page2', 'init.page3', 'init.loginFailed', 'init.sudoFailed', 'init.noFirewall']) {
    for (const locale of ['zh', 'en'] as const) expect(translate(locale, key)).not.toBe(key)
  }
})
