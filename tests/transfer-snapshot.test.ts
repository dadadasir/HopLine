import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TransferJob } from '../src/shared/types'
import { getState, patch } from '../src/renderer/src/state/store'
import { loadTransferSnapshot, upsertTransfer } from '../src/renderer/src/state/transfers'

const initial = getState()
const job: TransferJob = { id: 'upload', sessionId: 'files:host', direction: 'upload', name: 'file', localPath: '/file', remotePath: '/file', total: 100, loaded: 20, status: 'running' }
let complete: (jobs: TransferJob[]) => void
let event: (job: TransferJob) => void
const off = vi.fn()
const jobs = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  patch({ ...initial, transfers: {} })
  jobs.mockImplementation(() => new Promise<TransferJob[]>((resolve) => { complete = resolve }))
  vi.stubGlobal('window', { hopline: { sftp: { jobs }, on: (_name: string, callback: typeof event) => { event = callback; return off } } })
})
afterEach(() => { patch(initial); vi.unstubAllGlobals() })

it('keeps completion and new job events that arrive while loading a stale history snapshot', async () => {
  const stop = loadTransferSnapshot(job.sessionId)
  expect(jobs).toHaveBeenCalledWith(job.sessionId)
  const done = { ...job, status: 'done' as const, loaded: 100 }
  const newer = { ...job, id: 'new-upload', loaded: 5 }
  for (const row of [done, newer]) { event(row); upsertTransfer(row) }
  complete([job, { ...job, id: 'old-upload' }])
  await vi.waitFor(() => expect(off).toHaveBeenCalledTimes(1))
  expect(getState().transfers[job.sessionId]).toEqual([done, newer, { ...job, id: 'old-upload' }])
  stop()
  expect(off).toHaveBeenCalledTimes(1)
})

it('does not apply a snapshot after its view unmounts', async () => {
  const stop = loadTransferSnapshot(job.sessionId)
  stop()
  complete([job])
  await Promise.resolve()
  expect(getState().transfers).toEqual({})
  expect(off).toHaveBeenCalledTimes(1)
})

it('reports request failures and releases the temporary listener', async () => {
  jobs.mockRejectedValue(new Error('files disconnected'))
  const failure = vi.fn()
  loadTransferSnapshot(job.sessionId, failure)
  await vi.waitFor(() => expect(off).toHaveBeenCalledTimes(1))
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'files disconnected' }))
})
