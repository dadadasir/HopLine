export type QueueStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface QueueSnapshot {
  id: string
  status: QueueStatus
  loaded: number
  total: number
  error?: string
}

export interface TransferRunContext {
  signal: AbortSignal
  onProgress: (loaded: number, total: number) => void
}

export interface TransferTask {
  id: string
  run: (ctx: TransferRunContext) => Promise<void>
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: string }).name === 'AbortError'
  )
}

/**
 * File-level transfer queue. Limits how many tasks run at once and
 * supports cancelling a queued or in-flight task.
 */
export class TransferQueue {
  private pending: TransferTask[] = []
  private active = new Map<string, AbortController>()
  private cancelled = new Set<string>()
  private snapshots = new Map<string, QueueSnapshot>()

  constructor(
    private concurrency: number,
    private onEvent: (snapshot: QueueSnapshot) => void = () => {}
  ) {
    if (concurrency < 1) throw new Error('并发数至少为 1')
  }

  setConcurrency(concurrency: number): void {
    if (concurrency < 1) throw new Error('并发数至少为 1')
    this.concurrency = concurrency
    this.pump()
  }

  enqueue(task: TransferTask): void {
    if (this.cancelled.has(task.id) || this.active.has(task.id)) return
    if (this.pending.some((item) => item.id === task.id)) return
    this.emit({ id: task.id, status: 'queued', loaded: 0, total: 0 })
    this.pending.push(task)
    this.pump()
  }

  cancel(id: string): void {
    this.cancelled.add(id)
    const controller = this.active.get(id)
    if (controller) {
      controller.abort()
      return
    }
    const index = this.pending.findIndex((task) => task.id === id)
    if (index >= 0) {
      this.pending.splice(index, 1)
      this.emit({ id, status: 'cancelled', loaded: 0, total: 0 })
    }
  }

  get(id: string): QueueSnapshot | undefined {
    return this.snapshots.get(id)
  }

  list(): QueueSnapshot[] {
    return [...this.snapshots.values()]
  }

  get activeCount(): number {
    return this.active.size
  }

  private emit(snapshot: QueueSnapshot): void {
    this.snapshots.set(snapshot.id, snapshot)
    this.onEvent(snapshot)
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()
      if (!task) return
      if (this.cancelled.has(task.id)) continue
      const controller = new AbortController()
      this.active.set(task.id, controller)
      const current = this.snapshots.get(task.id)
      this.emit({
        id: task.id,
        status: 'running',
        loaded: current?.loaded ?? 0,
        total: current?.total ?? 0
      })
      task
        .run({
          signal: controller.signal,
          onProgress: (loaded, total) => {
            if (controller.signal.aborted) return
            this.emit({ id: task.id, status: 'running', loaded, total })
          }
        })
        .then(() => {
          const prev = this.snapshots.get(task.id)
          if (controller.signal.aborted) {
            this.emit({
              id: task.id,
              status: 'cancelled',
              loaded: prev?.loaded ?? 0,
              total: prev?.total ?? 0
            })
          } else {
            this.emit({
              id: task.id,
              status: 'done',
              loaded: prev?.total || prev?.loaded || 0,
              total: prev?.total || prev?.loaded || 0
            })
          }
        })
        .catch((error: unknown) => {
          const prev = this.snapshots.get(task.id)
          if (controller.signal.aborted || isAbortError(error)) {
            this.emit({
              id: task.id,
              status: 'cancelled',
              loaded: prev?.loaded ?? 0,
              total: prev?.total ?? 0
            })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          this.emit({
            id: task.id,
            status: 'error',
            loaded: prev?.loaded ?? 0,
            total: prev?.total ?? 0,
            error: message
          })
        })
        .finally(() => {
          this.active.delete(task.id)
          this.pump()
        })
    }
  }
}
