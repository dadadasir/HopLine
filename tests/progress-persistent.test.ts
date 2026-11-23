import { expect, it } from 'vitest'
import { parseProgress, visibleProgress } from '../src/renderer/src/logic/progress'
it('clamps progress, accepts indeterminate without a percentage, rejects malformed sequences and clears at 30 seconds', () => {
  expect(parseProgress('4;0', 0)).toBeNull()
  expect(parseProgress('4;3', 0)).toEqual({ state: 3, value: 0, updatedAt: 0 })
  const progress = parseProgress('4;1;150', 100)!
  expect(progress.value).toBe(100)
  expect(visibleProgress(progress, 30099)).toEqual(progress)
  expect(visibleProgress(progress, 30100)).toBeNull()
  for (const text of ['4;9;0', '4;1;-1', '4;1;NaN', '4;1;2;3', '4;1', 'hello']) expect(parseProgress(text, 0)).toBeUndefined()
})
