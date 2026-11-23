/// <reference path="../src/renderer/src/env.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostPublic, SessionInfo } from '../src/shared/types'
import { parseLayout, serializeLayout } from '../src/renderer/src/logic/layout'

const saved = JSON.stringify({ tabs: [{ kind: 'ssh', hostId: 'a' }, { kind: 'local' }, { kind: 'ssh', hostId: 'b' }], activeIndex: 1 })
const layoutKey = 'hopline.layout.v1'
const restoreKey = 'hopline.layout.restore'
const session = (id: string, kind: 'ssh' | 'local', hostId?: string): SessionInfo => ({
  id, kind, hostId, title: id, status: 'connected'
})

describe('layout codec', () => {
  it('keeps only structure, order and the active index', () => {
    const tabs = [
      { ...session('ssh-secret', 'ssh', 'a'), password: 'secret', screen: 'output' },
      session('local-secret', 'local')
    ]
    const raw = serializeLayout(tabs, 'local-secret')
    expect(JSON.parse(raw)).toEqual({ tabs: [{ kind: 'ssh', hostId: 'a' }, { kind: 'local' }], activeIndex: 1 })
    expect(raw).not.toMatch(/secret|output|password|screen|status|title/)
    expect(parseLayout(raw)).toEqual(JSON.parse(raw))
    expect(tabs[0]).toMatchObject({ password: 'secret', screen: 'output' })
  })

  it('handles an empty layout and skips SSH tabs without a usable host id', () => {
    expect(parseLayout(serializeLayout([], null))).toEqual({ tabs: [], activeIndex: -1 })
    expect(parseLayout(serializeLayout([session('missing', 'ssh'), session('local', 'local')], 'missing')))
      .toEqual({ tabs: [{ kind: 'local' }], activeIndex: 0 })
  })

  it.each([
    null, '', '{', 'null', '[]', '{}',
    JSON.stringify({ tabs: [], activeIndex: 0 }),
    JSON.stringify({ tabs: [], activeIndex: -1, password: 'extra' }),
    ...[
      { kind: 'other' }, { kind: 'ssh' }, { kind: 'ssh', hostId: '' }, { kind: 'ssh', hostId: '  ' },
      { kind: 'ssh', hostId: 1 }, { kind: 'ssh', hostId: 'a', id: 'session' },
      { kind: 'local', hostId: 'a' }, { kind: 'local', screen: 'output' }, null, []
    ].map((tab) => JSON.stringify({ tabs: [tab], activeIndex: 0 })),
    ...[-1, 1, 0.5, '0', null].map((activeIndex) => JSON.stringify({ tabs: [{ kind: 'local' }], activeIndex }))
  ])('discards invalid data: %s', (raw) => {
    expect(parseLayout(raw)).toBeNull()
  })
})

describe('layout lifecycle', () => {
  let state: typeof import('../src/renderer/src/state')
  let storage: Map<string, string>
  let stop: (() => void) | undefined
  const bridge = {
    ssh: { connect: vi.fn(), disconnect: vi.fn() },
    pty: { open: vi.fn(), close: vi.fn() }
  }
  const local = { getItem: vi.fn(), setItem: vi.fn() }

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.useFakeTimers()
    storage = new Map([[layoutKey, saved]])
    local.getItem.mockImplementation((key: string) => storage.get(key) ?? null)
    local.setItem.mockImplementation((key: string, value: string) => storage.set(key, value))
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('window', Object.assign(new EventTarget(), { hopline: bridge }))
    state = await import('../src/renderer/src/state')
    state.patch({ ready: true, hosts: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] as HostPublic[] })
    bridge.ssh.connect.mockImplementation(async ({ hostId }: { hostId: string }) => session(`ssh-${hostId}`, 'ssh', hostId))
    bridge.pty.open.mockResolvedValue(session('local', 'local'))
  })

  afterEach(() => {
    stop?.()
    stop = undefined
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('restores sequentially, preserves mixed order and selects the original active tab', async () => {
    let finish!: (value: SessionInfo) => void
    bridge.ssh.connect.mockReturnValueOnce(new Promise<SessionInfo>((resolve) => { finish = resolve }))
    const pending = state.restoreLayout()
    await state.restoreLayout()
    expect(bridge.ssh.connect).toHaveBeenCalledTimes(1)
    expect(bridge.pty.open).not.toHaveBeenCalled()
    finish(session('ssh-a', 'ssh', 'a'))
    await pending
    expect(state.getState().tabs.map((tab) => tab.id)).toEqual(['ssh-a', 'local', 'ssh-b'])
    expect(state.getState().activeId).toBe('local')
    expect(bridge.ssh.connect.mock.calls.map(([input]) => input.hostId)).toEqual(['a', 'b'])
    await state.restoreLayout()
    expect(bridge.pty.open).toHaveBeenCalledTimes(1)
  })

  it('waits for ready and does not duplicate existing tabs', async () => {
    state.patch({ ready: false })
    await state.restoreLayout()
    expect(bridge.ssh.connect).not.toHaveBeenCalled()
    state.patch({ ready: true })
    state.upsertTab(session('existing', 'local'))
    await state.restoreLayout()
    expect(bridge.ssh.connect).not.toHaveBeenCalled()
    expect(bridge.pty.open).not.toHaveBeenCalled()
    expect(state.getState().activeId).toBe('existing')
  })

  it('can restore after an early call before ready', async () => {
    state.patch({ ready: false })
    await state.restoreLayout()
    state.patch({ ready: true })
    await state.restoreLayout()
    expect(state.getState().tabs).toHaveLength(3)
  })

  it('skips deleted hosts while retaining the original active index mapping', async () => {
    state.patch({ hosts: [{ id: 'b', name: 'B' }] as HostPublic[] })
    await state.restoreLayout()
    expect(state.getState().tabs.map((tab) => tab.id)).toEqual(['local', 'ssh-b'])
    expect(state.getState().activeId).toBe('local')
    expect(bridge.ssh.connect).toHaveBeenCalledTimes(1)
  })

  it('continues after connection failures, toasts once and falls back if the active tab failed', async () => {
    bridge.ssh.connect.mockRejectedValueOnce(new Error('SSH failed'))
    bridge.pty.open.mockRejectedValueOnce(new Error('PTY failed'))
    await state.restoreLayout()
    expect(state.getState().tabs.map((tab) => tab.id)).toEqual(['ssh-b'])
    expect(state.getState().activeId).toBe('ssh-b')
    expect(state.getState().toasts.map((toast) => [toast.tone, toast.text])).toEqual([
      ['err', 'SSH failed'], ['err', 'PTY failed']
    ])
  })

  it('defaults to enabled and persists the renderer-only opt-out', async () => {
    expect(state.restoreLayoutEnabled()).toBe(true)
    state.setRestoreLayoutEnabled(false)
    expect(storage.get(restoreKey)).toBe('false')
    expect(state.restoreLayoutEnabled()).toBe(false)
    await state.restoreLayout()
    expect(bridge.ssh.connect).not.toHaveBeenCalled()
    expect(bridge.pty.open).not.toHaveBeenCalled()
    state.setRestoreLayoutEnabled(true)
    expect(state.restoreLayoutEnabled()).toBe(true)
  })

  it('silently skips invalid layouts and unreadable storage', async () => {
    storage.set(layoutKey, '{broken')
    await state.restoreLayout()
    expect(bridge.ssh.connect).not.toHaveBeenCalled()
    local.getItem.mockImplementation(() => { throw new Error('denied') })
    expect(state.restoreLayoutEnabled()).toBe(false)
    await expect(state.restoreLayout()).resolves.toBeUndefined()
  })

  it('silently skips a layout read failure after the preference was read', async () => {
    local.getItem.mockImplementation((key: string) => {
      if (key === layoutKey) throw new Error('denied')
      return null
    })
    await expect(state.restoreLayout()).resolves.toBeUndefined()
    expect(bridge.pty.open).not.toHaveBeenCalled()
    expect(bridge.ssh.connect).not.toHaveBeenCalled()
  })

  it('debounces adds, switches and removals; unrelated state changes do not reset the timer', async () => {
    stop = state.watchLayout()
    expect(local.setItem).not.toHaveBeenCalled()
    state.upsertTab(session('a', 'ssh', 'a'))
    vi.advanceTimersByTime(200)
    state.upsertTab(session('local', 'local'))
    state.patch({ activeId: 'a' })
    vi.advanceTimersByTime(200)
    state.toast('unrelated')
    state.upsertTab({ ...session('a', 'ssh', 'a'), status: 'closed' })
    expect(local.setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(local.setItem).toHaveBeenCalledTimes(1)
    expect(parseLayout(storage.get(layoutKey)!)).toEqual({
      tabs: [{ kind: 'ssh', hostId: 'a' }, { kind: 'local' }], activeIndex: 0
    })
    await state.closeTab('a')
    await state.closeTab('local')
    vi.advanceTimersByTime(250)
    expect(parseLayout(storage.get(layoutKey)!)).toEqual({ tabs: [], activeIndex: -1 })
  })

  it('flushes pending changes at unload and unregisters on cleanup', () => {
    stop = state.watchLayout()
    state.upsertTab(session('local', 'local'))
    window.dispatchEvent(new Event('beforeunload'))
    expect(local.setItem).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    expect(local.setItem).toHaveBeenCalledTimes(1)
    state.patch({ tabs: [], activeId: null })
    stop()
    stop = undefined
    expect(local.setItem).toHaveBeenCalledTimes(2)
    state.upsertTab(session('later', 'local'))
    window.dispatchEvent(new Event('beforeunload'))
    vi.advanceTimersByTime(500)
    expect(local.setItem).toHaveBeenCalledTimes(2)
  })

  it('saves restored or pre-existing tabs but preserves saved data for an untouched empty startup', async () => {
    stop = state.watchLayout()
    window.dispatchEvent(new Event('beforeunload'))
    vi.advanceTimersByTime(500)
    expect(storage.get(layoutKey)).toBe(saved)
    stop()
    await state.restoreLayout()
    stop = state.watchLayout()
    vi.advanceTimersByTime(250)
    expect(storage.get(layoutKey)).toBe(saved)
    expect(local.setItem).toHaveBeenCalledTimes(1)
  })

  it('silently tolerates write failures for layout and preference', () => {
    local.setItem.mockImplementation(() => { throw new Error('quota') })
    expect(() => state.setRestoreLayoutEnabled(false)).not.toThrow()
    stop = state.watchLayout()
    state.upsertTab(session('local', 'local'))
    expect(() => vi.advanceTimersByTime(250)).not.toThrow()
    expect(state.getState().toasts).toEqual([])
  })
})
