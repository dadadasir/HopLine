/// <reference path="../src/renderer/src/env.d.ts" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSelectorSnapshot, shallowEqual } from '../src/renderer/src/logic/selector'
import {
  getState, patch, subscribe, themeOf, upsertTransfer, type AppState
} from '../src/renderer/src/state'
import type { TransferJob } from '../src/shared/types'

const initial = getState()
const cleanups: (() => void)[] = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  patch(() => initial)
})

// Count selected snapshot changes using the same cache as useAppSelector.
// This is a DOM-free subscription test, not a mounted React render count.
function observe<T>(selector: (state: AppState) => T, isEqual?: (a: T, b: T) => boolean) {
  const snapshot = createSelectorSnapshot(getState, selector, isEqual)
  let previous = snapshot()
  const changed = vi.fn()
  cleanups.push(subscribe(() => {
    const next = snapshot()
    if (!Object.is(previous, next)) {
      previous = next
      changed(next)
    }
  }))
  return { snapshot, changed }
}

describe('selected store snapshots', () => {
  it('keeps raw patch notifications but does not invalidate tabs for a toast', () => {
    const tabs = observe((state) => state.tabs)
    const toasts = observe((state) => state.toasts)
    const raw = vi.fn()
    const unsubscribe = subscribe(raw)
    cleanups.push(unsubscribe)
    const originalTabs = tabs.snapshot()

    patch({ toasts: [{ id: 1, text: '已保存', tone: 'ok' }] })
    expect(raw).toHaveBeenCalledTimes(1)
    expect(toasts.changed).toHaveBeenCalledTimes(1)
    expect(tabs.changed).not.toHaveBeenCalled()
    expect(tabs.snapshot()).toBe(originalTabs)

    unsubscribe()
    patch((state) => ({ ...state, tabs: [...state.tabs] }))
    expect(raw).toHaveBeenCalledTimes(1)
    expect(tabs.changed).toHaveBeenCalledTimes(1)
  })

  it('caches an allocating selector even with the default Object.is comparison', () => {
    const selector = vi.fn((state: AppState) => ({ tabs: state.tabs }))
    const snapshot = createSelectorSnapshot(getState, selector)
    const first = snapshot()
    expect(snapshot()).toBe(first)
    expect(snapshot()).toBe(first)
    patch((state) => state)
    expect(snapshot()).toBe(first)
    expect(selector).toHaveBeenCalledTimes(1)

    patch({ query: '新查询' })
    expect(snapshot()).not.toBe(first)
    expect(selector).toHaveBeenCalledTimes(2)
  })

  it('retains object and array references across unrelated patches with shallowEqual', () => {
    const object = observe((state) => ({ tabs: state.tabs, activeId: state.activeId }), shallowEqual)
    const array = observe((state) => [state.tabs, state.activeId], shallowEqual)
    const firstObject = object.snapshot()
    const firstArray = array.snapshot()
    patch({ query: '无关查询' })
    expect(object.snapshot()).toBe(firstObject)
    expect(array.snapshot()).toBe(firstArray)
    expect(object.changed).not.toHaveBeenCalled()
    expect(array.changed).not.toHaveBeenCalled()

    patch({ activeId: 'ssh-1' })
    expect(object.changed).toHaveBeenCalledTimes(1)
    expect(array.changed).toHaveBeenCalledTimes(1)
    expect(object.snapshot().activeId).toBe('ssh-1')
  })

  it('honors custom equality and keeps caches for different selectors independent', () => {
    const a = observe((state) => ({ size: state.query.length }), (left, right) => left.size === right.size)
    const b = observe((state) => state.query)
    patch({ query: '甲' })
    const first = a.snapshot()
    patch({ query: '乙' })
    expect(a.snapshot()).toBe(first)
    expect(a.changed).toHaveBeenCalledTimes(1)
    expect(b.changed).toHaveBeenCalledTimes(2)
  })

  it('caches undefined and null selections', () => {
    const selector = vi.fn((state: AppState) => state.transfers.missing)
    const missing = createSelectorSnapshot(getState, selector)
    expect(missing()).toBeUndefined()
    expect(missing()).toBeUndefined()
    expect(selector).toHaveBeenCalledTimes(1)
    const confirm = observe((state) => state.confirm)
    patch({ query: '查询' })
    expect(confirm.snapshot()).toBeNull()
    expect(confirm.changed).not.toHaveBeenCalled()
  })

  it('isolates transfer sessions and leaves terminal subscriptions unchanged', () => {
    const tabs = observe((state) => state.tabs)
    const active = observe((state) => state.activeId)
    const font = observe((state) => state.settings?.fontSize ?? 13)
    const theme = observe(themeOf)
    const first = observe((state) => state.transfers['ssh-1'])
    const second = observe((state) => state.transfers['ssh-2'])
    const job: TransferJob = {
      id: 'upload-1', sessionId: 'ssh-1', direction: 'upload', name: '文件',
      localPath: '/tmp/file', remotePath: '/file', total: 100, loaded: 0, status: 'queued'
    }
    upsertTransfer(job)
    const firstJobs = first.snapshot()
    upsertTransfer({ ...job, id: 'upload-2', sessionId: 'ssh-2' })
    expect(first.snapshot()).toBe(firstJobs)
    upsertTransfer({ ...job, status: 'running', loaded: 50 })
    expect(first.snapshot()).toEqual([{ ...job, status: 'running', loaded: 50 }])
    expect(first.changed).toHaveBeenCalledTimes(2)
    expect(second.changed).toHaveBeenCalledTimes(1)
    patch({ toasts: [{ id: 1, text: '已上传', tone: 'ok' }] })
    for (const selection of [tabs, active, font, theme]) expect(selection.changed).not.toHaveBeenCalled()

    patch({ osTheme: 'dark' })
    expect(theme.changed).toHaveBeenCalledExactlyOnceWith('dark')
  })
})

describe('shallowEqual', () => {
  it.each([
    [null, null, true], [null, {}, false], [{}, null, false], [undefined, null, false],
    [NaN, NaN, true], [0, -0, false], [1, '1', false],
    [[], [], true], [[1, 2], [1, 2], true], [[1, 2], [2, 1], false],
    [[1], [1, 2], false], [[], {}, false], [Array(1), Array(2), false],
    [Array(1), [undefined], false],
    [{}, {}, true], [{ a: 1, b: 2 }, { b: 2, a: 1 }, true],
    [{ a: undefined }, {}, false], [{ a: 1 }, { b: 1 }, false],
    [{ value: NaN }, { value: NaN }, true], [{ value: 0 }, { value: -0 }, false],
    [{ value: {} }, { value: {} }, false],
    [new Date(0), new Date(1), false], [new Map(), new Map(), false]
  ])('compares %j and %j as %s', (left, right, expected) => {
    expect(shallowEqual(left, right)).toBe(expected)
  })

  it('compares own fields safely, including null-prototype objects', () => {
    const child = {}
    expect(shallowEqual({ child }, { child })).toBe(true)
    expect(shallowEqual([child], [child])).toBe(true)
    expect(shallowEqual({ hasOwnProperty: 1 }, { hasOwnProperty: 1 })).toBe(true)
    expect(shallowEqual(Object.assign(Object.create(null), { child }), Object.assign(Object.create(null), { child }))).toBe(true)
    expect(shallowEqual({ child }, Object.create({ child }))).toBe(false)
  })
})
