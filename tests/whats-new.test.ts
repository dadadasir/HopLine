import { expect, it } from 'vitest'
import { releaseNotesBetween, whatsNew } from '../src/renderer/src/whats-new'
import { translate } from '../src/renderer/src/i18n'

it.each(['0.2.0', '0.3.0', '0.4.0'])('ships matching Chinese and English notes for %s', (version) => {
  const notes = whatsNew[version]
  expect(notes.zh.length).toBe(notes.en.length)
  expect(notes.zh.length).toBeGreaterThanOrEqual(3)
  expect(notes.zh.length).toBeLessThanOrEqual(5)
  for (const entry of [...notes.zh, ...notes.en]) expect(entry.trim()).not.toBe('')
})

it.each(['zh', 'en'] as const)('localizes onboarding, release notices and overview empty states (%s)', (locale) => {
  for (const key of ['onboarding.title', 'onboarding.skip', 'onboarding.add', 'onboarding.import', 'onboarding.manual', 'onboarding.paste', 'onboarding.connectHost', 'onboarding.run', 'collection.settings', 'whatsNew.view', 'whatsNew.title', 'whatsNew.unlisted', 'overview.emptyHosts']) {
    expect(translate(locale, key)).not.toBe(key)
  }
  expect(translate(locale, 'whatsNew.updated', { version: '0.3.0' })).toContain('0.3.0')
  expect(translate(locale, 'collection.pending', { count: 4 })).toContain('4')
  expect(translate(locale, 'onboarding.connectHost', { name: 'my-host' })).toContain('my-host')
})


it.each([
  ['0.3.0', '0.4.0', ['0.4.0']],
  ['0.2.0', '0.4.0', ['0.4.0', '0.3.0']],
  ['0.1.0', '0.3.0', ['0.3.0', '0.2.0']],
  ['0.2.0', '0.3.0', ['0.3.0']],
  ['0.3.0', '0.2.0', []], ['0.3.0', '0.3.0', []],
  ['0.1.0', '0.2.0', ['0.2.0']], ['0.2.0', '0.10.0', ['0.4.0', '0.3.0']],
  ['0.1.0', '0.3.0-rc.1', ['0.2.0']], ['0.3.0-rc.1', '0.3.0', ['0.3.0']],
  ['0.2.0+build.1', '0.3.0+build.2', ['0.3.0']], ['invalid', '0.3.0', []]
])('selects all release notes between %s and %s newest first', (previous, current, versions) => {
  for (const locale of ['zh', 'en'] as const) {
    const entries = releaseNotesBetween(previous as string, current as string, locale)
    expect(entries.map((entry) => entry.version)).toEqual(versions)
    for (const entry of entries) expect(entry.notes).toEqual(whatsNew[entry.version][locale])
  }
})
