import { afterEach, expect, it, vi } from 'vitest'
import { getEditionCapabilities } from '../src/ext/capabilities'
import { getMainCapabilities, setMainCapabilities } from '../src/main/ext/capabilities'
import { getRendererCapabilities, setRendererCapabilities } from '../src/renderer/src/ext/capabilities'
import communityMain from '../src/ext/community/main'
import communityRenderer from '../src/ext/community/renderer'

afterEach(() => { vi.stubGlobal('__HOPLINE_EDITION__', 'community'); setMainCapabilities({ overviewHostLimit: 5 }); setRendererCapabilities({ overviewHostLimit: 5 }); vi.unstubAllGlobals() })

it.each(['community', 'pro'] as const)('shares the %s overview capability across both processes', (edition) => {
  vi.stubGlobal('__HOPLINE_EDITION__', edition)
  const expected = { overviewHostLimit: edition === 'community' ? 5 : Number.POSITIVE_INFINITY }
  expect(getEditionCapabilities(edition)).toEqual(expected)
  expect(getMainCapabilities()).toEqual({ overviewHostLimit: 5 })
  expect(getRendererCapabilities()).toEqual({ overviewHostLimit: 5 })
  setMainCapabilities(expected); setRendererCapabilities(getMainCapabilities())
  expect(getMainCapabilities()).toEqual(expected)
  expect(getRendererCapabilities()).toEqual(expected)
})

it('defaults to the community capability when the build-time edition is absent', () => {
  vi.stubGlobal('__HOPLINE_EDITION__', undefined)
  expect(getMainCapabilities()).toEqual({ overviewHostLimit: 5 })
  expect(getRendererCapabilities()).toEqual({ overviewHostLimit: 5 })
})

it('preserves the default extension-array contract without loading licensed features', () => {
  expect(communityMain).toEqual([])
  expect(communityRenderer).toEqual([])
})
