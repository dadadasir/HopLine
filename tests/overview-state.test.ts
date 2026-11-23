/// <reference path="../src/renderer/src/env.d.ts" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getState, patch } from '../src/renderer/src/state/store'
import { openOverview, refreshHost, watchOverview } from '../src/renderer/src/state/overview'

const initial = getState(), off = vi.fn(), run = vi.fn(), latest = vi.fn()
let listener: (value: unknown) => void
const old = { open: { snapshot: null, updatedAt: null, error: 'old' } }, fresh = { open: { snapshot: null, updatedAt: null, error: 'new' } }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers()
  patch({ ...initial, collecting: [], snapshots: {}, toasts: [] })
  vi.stubGlobal('window', { hopline: { collect: { latest, run }, on: vi.fn((_channel, fn) => { listener = fn; return off }) } })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('opens overview without changing active tabs or closing sessions', () => {
  const tabs = [{ id: 'a', kind: 'ssh' as const, title: 'a', status: 'connected' as const, sftpOpen: false }]
  patch({ tabs, activeId: 'a', paletteOpen: true })
  openOverview()
  expect(getState()).toMatchObject({ tabs, activeId: 'a', overviewOpen: true, paletteOpen: false })
})
it('loads persisted records and subscribes to subsequent updates', async () => {
  latest.mockResolvedValue(old)
  const stop = watchOverview(); await Promise.resolve()
  expect(getState().snapshots).toEqual(old)
  listener(fresh); expect(getState().snapshots).toEqual(fresh)
  stop(); expect(off).toHaveBeenCalledTimes(1)
})
it('does not let a stale initial response overwrite an event or update an unmounted subscription', async () => {
  let resolve!: (value: unknown) => void
  latest.mockReturnValue(new Promise((finish) => { resolve = finish }))
  const stop = watchOverview()
  listener(fresh); resolve(old); await Promise.resolve()
  expect(getState().snapshots).toEqual(fresh)
  stop()
  latest.mockReturnValue(new Promise((finish) => { resolve = finish }))
  const stopAgain = watchOverview(); stopAgain(); resolve(old); await Promise.resolve()
  expect(getState().snapshots).toEqual(fresh)
})
it('avoids duplicate refresh IPC and clears busy state on failure', async () => {
  let reject!: (error: Error) => void
  run.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
  const pending = refreshHost('a'); await refreshHost('a')
  expect(run).toHaveBeenCalledExactlyOnceWith('a')
  expect(getState().collecting).toEqual(['a'])
  reject(new Error('disk full')); await pending
  expect(getState().collecting).toEqual([])
  expect(getState().toasts).toMatchObject([{ text: 'disk full', tone: 'err' }])
})
