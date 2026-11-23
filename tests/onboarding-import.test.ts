import { createElement, type EffectCallback, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'
import type { HostPublic, SessionInfo } from '../src/shared/types'
import { Onboarding } from '../src/renderer/src/components/Onboarding'
import { ImportDialog } from '../src/renderer/src/components/ImportDialog'
import { translate } from '../src/renderer/src/i18n'

const mocks = vi.hoisted(() => ({
  locale: 'zh' as 'zh' | 'en',
  state: { hosts: [] as HostPublic[], tabs: [] as SessionInfo[], groups: [], connecting: null, route: { page: 'overview' }, snapshots: {}, settingsOpen: false, importSshConfigOpen: false },
  effects: [] as EffectCallback[],
  buttons: [] as { children?: ReactNode; onClick?: () => void; disabled?: boolean }[],
  preview: vi.fn(), apply: vi.fn(), patch: vi.fn(), connect: vi.fn(), check: vi.fn()
}))

// Server rendering alone omits effects. Flush captured mount effects explicitly
// so this regression detects an accidental return of the background scan.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: EffectCallback) => { mocks.effects.push(effect) }
}))
vi.mock('../src/renderer/src/state', () => ({
  api: () => ({ hosts: { importSshConfig: { preview: mocks.preview, apply: mocks.apply } }, security: { check: mocks.check } }),
  useAppSelector: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
  patch: mocks.patch, connectHost: mocks.connect, openOverview: vi.fn(), refreshHost: vi.fn(), shallowEqual: vi.fn(), toast: vi.fn(), errorText: String
}))
vi.mock('../src/renderer/src/state/security', () => ({ openSecurity: vi.fn() }))
vi.mock('../src/renderer/src/logic/onboarding', async (original) => ({
  ...await original<typeof import('../src/renderer/src/logic/onboarding')>(),
  readOnboardingDone: () => false, readOnboardingProgress: () => null, finishOnboarding: vi.fn()
}))
vi.mock('../src/renderer/src/components/ui', () => {
  const button = (props: { children?: ReactNode; onClick?: () => void; disabled?: boolean }) => {
    mocks.buttons.push(props)
    return createElement('button', props)
  }
  return {
    useT: () => (key: string, values?: Record<string, string | number>) => translate(mocks.locale, key, values),
    PrimaryButton: button, QuietButton: button,
    Modal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Field: ({ children }: { children?: ReactNode }) => createElement('label', null, children),
    TextInput: () => createElement('input')
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.locale = 'zh'; mocks.state.importSshConfigOpen = false
  mocks.effects.length = 0; mocks.buttons.length = 0
  mocks.preview.mockResolvedValue({ hosts: [], warnings: [] })
})
async function flushMountEffects() {
  for (const effect of mocks.effects.splice(0)) effect()
  await Promise.resolve()
}
const renderOnboarding = () => renderToStaticMarkup(createElement(Onboarding, { children: 'workspace' }))

it.each(['zh', 'en'] as const)('offers import in %s without reading SSH config on mount', async locale => {
  mocks.locale = locale
  const html = renderOnboarding()
  await flushMountEffects()
  expect(html).toContain(translate(locale, 'onboarding.import'))
  expect(html).toContain(translate(locale, 'onboarding.manual'))
  expect(mocks.preview).not.toHaveBeenCalled()
  expect(mocks.apply).not.toHaveBeenCalled()
})

it('reads SSH config only after the user opens the existing import dialog', async () => {
  renderOnboarding()
  renderToStaticMarkup(createElement(ImportDialog))
  await flushMountEffects()
  expect(mocks.preview).not.toHaveBeenCalled()
  mocks.buttons.find(button => button.children === translate('zh', 'onboarding.import'))!.onClick!()
  expect(mocks.patch).toHaveBeenCalledWith({ importSshConfigOpen: true })
  expect(mocks.preview).not.toHaveBeenCalled()
  mocks.state.importSshConfigOpen = true
  renderToStaticMarkup(createElement(ImportDialog))
  await flushMountEffects()
  expect(mocks.preview).toHaveBeenCalledTimes(1)
  expect(mocks.apply).not.toHaveBeenCalled()
})

it('keeps manual host creation independent of SSH config import', async () => {
  renderOnboarding()
  await flushMountEffects()
  mocks.buttons.find(button => button.children === translate('zh', 'onboarding.manual'))!.onClick!()
  expect(mocks.patch).toHaveBeenCalledWith({ hostDialog: 'new' })
  expect(mocks.preview).not.toHaveBeenCalled()
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.check).not.toHaveBeenCalled()
})

it('opens text recognition directly without reading SSH configuration', async () => {
  renderOnboarding()
  await flushMountEffects()
  mocks.buttons.find(button => button.children === translate('zh', 'onboarding.paste'))!.onClick!()
  expect(mocks.patch).toHaveBeenCalledWith({ hostDialog: 'recognize' })
  expect(mocks.preview).not.toHaveBeenCalled()
})
