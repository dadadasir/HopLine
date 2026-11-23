import { describe, expect, it } from 'vitest'
import { enqueuePrompt, dequeuePrompt } from '../src/renderer/src/logic/prompt-queue'
import { paletteItems, moveSelection } from '../src/renderer/src/logic/palette'

describe('authentication prompt queue', () => {
  const first = { requestId: 'host-1', kind: 'hostKey' }
  const second = { requestId: 'kbd-2', kind: 'keyboard' }

  it('preserves every concurrent prompt in arrival order without mutating the input', () => {
    const original = [first]
    const queue = enqueuePrompt(original, second)
    expect(original).toEqual([first])
    expect(queue).toEqual([first, second])
    expect(dequeuePrompt(queue, first.requestId)).toEqual([second])
    expect(queue).toEqual([first, second])
  })

  it('ignores duplicates and stale responses instead of dropping another prompt', () => {
    const queue = [first, second]
    expect(enqueuePrompt(queue, first)).toEqual(queue)
    expect(dequeuePrompt(queue, second.requestId)).toEqual(queue)
    expect(dequeuePrompt(queue, 'expired')).toEqual(queue)
    const next = dequeuePrompt(queue, first.requestId)
    expect(dequeuePrompt(next, first.requestId)).toEqual([second])
    expect(dequeuePrompt(next, second.requestId)).toEqual([])
    expect(dequeuePrompt([], first.requestId)).toEqual([])
  })
})

describe('command palette', () => {
  const hosts = [
    { id: 'local', name: 'Production', host: 'prod.example', username: 'Alice' },
    { id: 'db', name: '数据库', host: 'db.example', username: 'Bob' }
  ]
  const actions = [
    { id: 'local', label: 'New local terminal', run: () => {} },
    { id: 'backup', label: '立即备份', run: () => {} }
  ]

  it('combines hosts and actions in display order with distinct keys', () => {
    const items = paletteItems(hosts, actions, '')
    expect(items.map((item) => item.id)).toEqual(['host:local', 'host:db', 'action:local', 'action:backup'])
    expect(items.map((item) => item.kind)).toEqual(['host', 'host', 'action', 'action'])
  })

  it.each([
    ['  PRODUCTION ', ['host:local']],
    ['example', ['host:local', 'host:db']],
    ['ALICE', ['host:local']],
    ['数据库', ['host:db']],
    ['LOCAL', ['action:local']],
    ['备份', ['action:backup']],
    ['missing', []]
  ])('filters names, addresses, users and actions for %s', (query, expected) => {
    expect(paletteItems(hosts, actions, query).map((item) => item.id)).toEqual(expected)
  })

  it('moves across the group boundary and clamps at the ends', () => {
    expect(moveSelection(1, 1, 4)).toBe(2)
    expect(moveSelection(2, -1, 4)).toBe(1)
    expect(moveSelection(0, -1, 4)).toBe(0)
    expect(moveSelection(3, 1, 4)).toBe(3)
  })

  it('handles empty, single-item and shrinking lists', () => {
    expect(moveSelection(0, 1, 0)).toBe(-1)
    expect(moveSelection(-1, -1, 0)).toBe(-1)
    expect(moveSelection(-1, 1, 1)).toBe(0)
    expect(moveSelection(0, -1, 1)).toBe(0)
    expect(moveSelection(8, 0, 2)).toBe(1)
    expect(moveSelection(-1, 0, 3)).toBe(0)
  })
})
