/// <reference path="../src/renderer/src/env.d.ts" />
import { afterEach, expect, it, vi } from 'vitest'
import type { HoplineApi } from '../src/shared/api'
import { expirePrompt, dequeuePrompt } from '../src/renderer/src/logic/prompt-queue'
import { subscribePromptExpiry, queueAuthentication } from '../src/renderer/src/state/prompts'
import { getState, patch } from '../src/renderer/src/state/store'
const mocks = vi.hoisted(() => ({ expose: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { on: mocks.on, removeListener: mocks.removeListener }, webUtils: {}
}))
import '../src/preload/index'
const bridge = mocks.expose.mock.calls[0][1] as HoplineApi

afterEach(() => { patch({ prompts: [] }); vi.clearAllMocks(); vi.unstubAllGlobals() })
it('expires the head or an item waiting behind it without changing other requests or the input', () => {
  const queue = [{ requestId: 'a' }, { requestId: 'b' }, { requestId: 'c' }]
  expect(expirePrompt(queue, 'b')).toEqual([queue[0], queue[2]])
  expect(expirePrompt(queue, 'a')).toEqual(queue.slice(1))
  expect(expirePrompt(queue, 'missing')).toEqual(queue)
  expect(expirePrompt(dequeuePrompt(queue, 'a'), 'a')).toEqual(queue.slice(1))
  expect(queue).toHaveLength(3)
})
it('forwards expiration through preload into state and removes its subscription', () => {
  vi.stubGlobal('window', { hopline: bridge })
  const stop = subscribePromptExpiry()
  for (const requestId of ['a', 'b', 'c']) queueAuthentication({ kind: 'keyboard', requestId, name: '', instructions: '', prompts: [] })
  const [channel, listener] = mocks.on.mock.calls[0]
  expect(channel).toBe('prompt:expired')
  listener({ sender: 'private' }, { requestId: 'b' })
  listener({}, { requestId: 'b' })
  expect(getState().prompts.map((p) => p.requestId)).toEqual(['a', 'c'])
  stop()
  expect(mocks.removeListener).toHaveBeenCalledExactlyOnceWith('prompt:expired', listener)
})
