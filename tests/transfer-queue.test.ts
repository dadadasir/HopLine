import { describe, expect, it } from 'vitest'
import { TransferQueue } from '../src/core/transfer-queue'
import { resumeOffset, shellEscape, shouldPackSmallFiles, uploadRange } from '../src/core/shell'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('transfer queue', () => {
  it('never runs more tasks than the concurrency limit', async () => {
    const queue = new TransferQueue(2)
    let active = 0
    let peak = 0
    const gates = Array.from({ length: 5 }, () => deferred<void>())
    gates.forEach((gate, index) => {
      queue.enqueue({
        id: `job-${index}`,
        run: async ({ signal }) => {
          active += 1
          peak = Math.max(peak, active)
          await gate.promise
          if (signal.aborted) {
            active -= 1
            throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          }
          active -= 1
        }
      })
    })
    await viTick()
    expect(queue.activeCount).toBe(2)
    expect(queue.get('job-2')?.status).toBe('queued')
    gates[0]!.resolve()
    await viTick()
    expect(queue.activeCount).toBe(2)
    expect(queue.get('job-2')?.status).toBe('running')
    gates.slice(1).forEach((gate) => gate.resolve())
    await viTick()
    expect(peak).toBe(2)
    expect(queue.list().every((job) => job.status === 'done')).toBe(true)
  })

  it('cancels a queued task before it starts and aborts a running one', async () => {
    const queue = new TransferQueue(1)
    const first = deferred<void>()
    let secondStarted = false
    queue.enqueue({
      id: 'running',
      run: ({ signal }) =>
        new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
          first.promise.then(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          })
        })
    })
    queue.enqueue({
      id: 'waiting',
      run: async () => {
        secondStarted = true
      }
    })
    await viTick()
    queue.cancel('waiting')
    expect(queue.get('waiting')?.status).toBe('cancelled')
    queue.cancel('running')
    await viTick()
    expect(queue.get('running')?.status).toBe('cancelled')
    expect(secondStarted).toBe(false)
    first.resolve()
  })

  it('records progress and keeps going after a failure', async () => {
    const events: string[] = []
    const queue = new TransferQueue(1, (snapshot) => {
      if (snapshot.status === 'running' && snapshot.loaded > 0) events.push(`${snapshot.id}:${snapshot.loaded}`)
    })
    queue.enqueue({
      id: 'file',
      run: async ({ onProgress }) => {
        onProgress(40, 100)
        onProgress(100, 100)
      }
    })
    queue.enqueue({
      id: 'bad',
      run: async () => {
        throw new Error('disk full')
      }
    })
    queue.enqueue({
      id: 'after',
      run: async () => {}
    })
    await viTick()
    expect(events).toEqual(['file:40', 'file:100'])
    expect(queue.get('file')?.status).toBe('done')
    expect(queue.get('bad')).toMatchObject({ status: 'error', error: 'disk full' })
    expect(queue.get('after')?.status).toBe('done')
  })

  it('computes resume offsets and the small-file pack heuristic', () => {
    expect(resumeOffset(null, 100)).toEqual({ offset: 0, done: false })
    expect(resumeOffset(0, 100)).toEqual({ offset: 0, done: false })
    expect(resumeOffset(40, 100)).toEqual({ offset: 40, done: false })
    expect(resumeOffset(100, 100)).toEqual({ offset: 100, done: true })
    expect(resumeOffset(120, 100)).toEqual({ offset: 0, done: false })
    expect(resumeOffset(null, 0)).toEqual({ offset: 0, done: false })
    expect(resumeOffset(NaN, 100)).toEqual({ offset: 0, done: false })
    expect(() => resumeOffset(0, -1)).toThrow('文件大小不合法')
    expect(uploadRange(null, 100)).toEqual({ offset: 0, done: false })
    expect(uploadRange(40, 100)).toEqual({ offset: 40, done: false })
    expect(uploadRange(100, 100)).toEqual({ offset: 100, done: true })
    expect(uploadRange(140, 100)).toEqual({ offset: 0, done: false })
    expect(uploadRange(0, 0)).toEqual({ offset: 0, done: true })
    expect(shouldPackSmallFiles(Array.from({ length: 12 }, () => ({ size: 1000 })))).toBe(true)
    expect(shouldPackSmallFiles(Array.from({ length: 11 }, () => ({ size: 100 })))).toBe(false)
    expect(shouldPackSmallFiles(Array.from({ length: 20 }, () => ({ size: 80 * 1024 })))).toBe(false)
    expect(shellEscape(`it's /tmp/a b`)).toBe(`'it'\\''s /tmp/a b'`)
  })
})

async function viTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}
