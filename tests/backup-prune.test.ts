import { describe, expect, it } from 'vitest'
import { selectBackupsToPrune } from '../src/core/backup-prune'

const day = 24 * 60 * 60 * 1000

function files(agesInDays: number[]) {
  return agesInDays.map((age, index) => ({
    name: `b${index}.hopline-backup`,
    mtimeMs: 1_000_000 - age * day
  }))
}

describe('backup prune', () => {
  const now = 1_000_000

  it('keeps a recent burst even when there are more than ten files', () => {
    const doomed = selectBackupsToPrune(files(Array.from({ length: 12 }, () => 1)), now)
    expect(doomed).toEqual([])
  })

  it('deletes only files that are both outside the newest ten and older than seven days', () => {
    const ages = [1, 1, 1, 2, 2, 3, 3, 4, 5, 6, 8, 9, 2]
    const doomed = selectBackupsToPrune(files(ages), now)
    expect(doomed.sort()).toEqual(['b10.hopline-backup', 'b11.hopline-backup'])
  })

  it('keeps fewer than ten files no matter how old they are', () => {
    expect(selectBackupsToPrune(files([30, 40, 50]), now)).toEqual([])
  })

  it('keeps the ten newest even when they are old, and prunes the rest', () => {
    const doomed = selectBackupsToPrune(files(Array.from({ length: 15 }, () => 30)), now)
    expect(doomed).toHaveLength(5)
    expect(doomed).not.toContain('b0.hopline-backup')
  })
})
