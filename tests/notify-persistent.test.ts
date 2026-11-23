import { afterEach, expect, it, vi } from 'vitest'
import { shouldNotify, needsAttention } from '../src/renderer/src/logic/notify'
import { createNotifier } from '../src/main/notify'
import { getState, patch } from '../src/renderer/src/state/store'
import { watchTaskNotifications, notifyTask, upsertTab, taskNotificationsEnabled, setTaskNotificationsEnabled } from '../src/renderer/src/state/tabs'

const mocks = vi.hoisted(() => ({ notifications: [] as { options: unknown; on: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn> }[] }))
vi.mock('electron', () => ({ Notification: class {
  static isSupported() { return true }
  on = vi.fn(); show = vi.fn()
  constructor(public options: unknown) { mocks.notifications.push(this) }
} }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.notifications.length = 0 })

it.each([[true, true, true, false], [true, false, true, true], [true, true, false, true], [false, false, false, false]])(
  'notification enabled=%s active=%s focused=%s => %s', (enabled, active, focused, expected) => expect(shouldNotify(enabled, active, focused)).toBe(expected))
it('shows attention only for unread, disconnect/error or OSC error, clearing when read', () => {
  expect(needsAttention('connected', false)).toBe(false)
  for (const state of [0, 1, 3, 4]) expect(needsAttention('connected', false, state)).toBe(false)
  expect(needsAttention('connected', false, 2)).toBe(true)
  expect(needsAttention('closed', false)).toBe(true)
  expect(needsAttention('error', false)).toBe(true)
  expect(needsAttention('connected', true)).toBe(true)
})
it('main process checks real focus, live sessions and rate; click only restores and activates the matching tab', () => {
  const win = { isFocused: vi.fn(() => true), isDestroyed: () => false, isMinimized: () => true,
    restore: vi.fn(), show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } }
  let live = [{ id: 'a' }, { id: 'b' }]
  const notify = createNotifier(() => win as never, () => live as never), message = { title: 't\t'.repeat(100), body: 'b\x7f'.repeat(300) }
  expect(notify('a', message, 'a', true)).toBe(false)
  expect(notify('a', message, 'b', false)).toBe(false)
  expect(notify('absent', message, 'b', true)).toBe(false)
  win.isFocused.mockReturnValue(false)
  expect(notify('a', message, 'a', true)).toBe(true)
  expect(mocks.notifications[0].options).toEqual({ title: 't'.repeat(64), body: 'b'.repeat(256) })
  expect(notify('a', message, 'b', true)).toBe(false)
  expect(notify('b', message, 'a', true)).toBe(true)
  const click = mocks.notifications[0].on.mock.calls.find(([event]) => event === 'click')![1]
  click()
  expect(win.restore).toHaveBeenCalledOnce()
  expect(win.focus).toHaveBeenCalledOnce()
  expect(win.webContents.send).toHaveBeenCalledWith('notify:activate', 'a')
  live = [{ id: 'b' }]; click()
  expect(win.focus).toHaveBeenCalledOnce()
})
it('renderer clears unread on foreground/focus, follows notification clicks, retains task state during status updates', async () => {
  const initial = getState(), events = new Map<string, (payload?: string) => void>(), values = new Map<string, string>()
  let focused = true
  const notify = vi.fn().mockResolvedValue(true)
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  vi.stubGlobal('document', { hasFocus: () => focused })
  vi.stubGlobal('window', { hopline: { notify, on: (event: string, cb: () => void) => { events.set(event, cb); return () => events.delete(event) } },
    addEventListener: (event: string, cb: () => void) => events.set(event, cb), removeEventListener: (event: string) => events.delete(event) })
  patch({ tabs: [{ id: 'a', kind: 'ssh', title: 'a', status: 'connected', sftpOpen: false, agent: 'Codex' },
    { id: 'b', kind: 'ssh', title: 'b', status: 'connected', sftpOpen: false }], activeId: 'b', overviewOpen: false })
  const off = watchTaskNotifications()
  try {
    expect(taskNotificationsEnabled()).toBe(true)
    notifyTask('a', { title: 'done', body: '' }); await Promise.resolve()
    expect(getState().tabs[0].unread).toBe(true)
    upsertTab({ id: 'a', kind: 'ssh', title: 'a', status: 'connected' }, false, false)
    expect(getState().activeId).toBe('b')
    expect(getState().tabs[0].agent).toBe('Codex')
    expect(getState().tabs[0].unread).toBe(true)
    focused = false; patch({ activeId: 'a' })
    expect(getState().tabs[0].unread).toBe(true)
    focused = true; events.get('focus')!()
    expect(getState().tabs[0].unread).toBe(false)
    patch({ activeId: 'b', overviewOpen: true }); events.get('notify:activate')!('a')
    expect(getState().activeId).toBe('a'); expect(getState().overviewOpen).toBe(false)
    setTaskNotificationsEnabled(false); expect(taskNotificationsEnabled()).toBe(false)
    notifyTask('b', { title: 'done', body: '' })
    expect(notify).toHaveBeenCalledOnce()
  } finally { off(); patch(initial) }
})
