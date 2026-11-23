import { beforeEach, describe, expect, it } from 'vitest'
import { getState, patch } from '../src/renderer/src/state/store'
import { navigate, openHost, openSessions } from '../src/renderer/src/state/navigation'
import { openOverview } from '../src/renderer/src/state/overview'
import { upsertTab } from '../src/renderer/src/state/tabs'

describe('workspace navigation preserves live terminal state', () => {
  beforeEach(() => patch({ route: { page: 'overview' }, tabs: [], activeId: null, transfers: {}, paletteOpen: false }))
  it('selects a host without opening a session or changing the active terminal', () => {
    upsertTab({ id: 'terminal', hostId: 'a', title: 'A', kind: 'ssh', status: 'connected' })
    const before = getState().tabs
    openHost('b', 'files')
    expect(getState().route).toEqual({ page: 'host', hostId: 'b', section: 'files' })
    expect(getState().tabs).toBe(before)
    expect(getState().activeId).toBe('terminal')
    openOverview()
    navigate({ page: 'activity' })
    openSessions()
    expect(getState().tabs).toBe(before)
    expect(getState().activeId).toBe('terminal')
  })
  it('activates terminal navigation when a real connection completes from a host view', () => {
    openHost('a')
    upsertTab({ id: 'a', hostId: 'a', title: 'A', kind: 'ssh', status: 'connected' })
    expect(getState().route).toEqual({ page: 'sessions' })
    expect(getState().overviewOpen).toBe(false)
  })
  it('background session status events do not navigate away from files', () => {
    openHost('b', 'files')
    upsertTab({ id: 'a', hostId: 'a', title: 'A', kind: 'ssh', status: 'closed' }, false, false)
    expect(getState().route).toEqual({ page: 'host', hostId: 'b', section: 'files' })
  })
  it('keeps legacy overview commands synchronized without overriding explicit routes', () => {
    openSessions()
    patch({ overviewOpen: true })
    expect(getState().route).toEqual({ page: 'overview' })
    openHost('a')
    expect(getState().overviewOpen).toBe(false)
    openOverview()
    expect(getState().route).toEqual({ page: 'overview' })
  })
})
