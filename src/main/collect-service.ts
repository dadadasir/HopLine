import { randomUUID } from 'node:crypto'
import type { CollectRecord, CollectRecords, SettingsPublic } from '../shared/types'
import type { BackgroundCollection } from '../ext/observations'
import { sshFailureReason } from './ssh/connect'
import { readJsonFile, writeJsonFile } from '../core/json-file'
import { collectHost } from './collect'
import type { ConnectionPool, Lease } from './ssh/pool'
import { execOnClient } from './ssh/exec'
import { logError } from './logger'

interface CollectOptions {
  /** Only automatic overview collection is scoped; manual host detail stays available. */
  overviewHostLimit?: number | (() => number)
  preferences?: () => Pick<SettingsPublic, 'autoCollect' | 'collectionIntervalMinutes'>
  securityScore?: (hostId: string) => number | undefined
  pool: Pick<ConnectionPool, 'isOpen' | 'acquire'>
  hosts: () => { id: string }[]
  filePath: string
  updated: (records: CollectRecords) => void
  collect?: typeof collectHost
}

interface PendingCollection {
  interaction: 'allow' | 'forbid'
  attemptId: string
  foreground: boolean
  scheduled: boolean
  record: Promise<CollectRecord>
  result: Promise<BackgroundCollection>
}

export class CollectService {
  private records: CollectRecords
  private pending = new Map<string, PendingCollection>()
  private controllers = new Map<string, AbortController>()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private windowOpen = false
  private overviewOpen = false
  private attempted = new Map<string, number>()
  private retry = new Map<string, { failures: number; at: number }>()
  private retained = new Map<string, { lease: Lease; unsubscribe: () => void }>()

  constructor(private readonly options: CollectOptions) {
    this.records = readJsonFile(options.filePath, (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('快照格式不正确')
      for (const row of Object.values(value) as CollectRecord[]) {
        if (!row || !(row.error === null || typeof row.error === 'string') || !(row.updatedAt === null || Number.isFinite(row.updatedAt))) throw new Error('快照记录不正确')
        if (row.snapshot !== null) {
          if (!row.snapshot || !Number.isFinite(row.snapshot.collectedAt)) throw new Error('快照时间不正确')
          for (const key of ['os', 'uptime', 'cpu', 'memory', 'load', 'disk', 'listeners', 'docker', 'services', 'web', 'certs'] as const) {
            const section = row.snapshot[key]
            if (!section || !['complete', 'partial', 'unavailable'].includes(section.status)) throw new Error('快照段不正确')
            if (section.status !== 'unavailable') {
              const array = ['disk', 'listeners', 'docker', 'services', 'web', 'certs'].includes(key)
              if (!section.data || typeof section.data !== 'object' || Array.isArray(section.data) !== array) throw new Error('快照数据不正确')
              if (array && (section.data as unknown[]).some((item) => !item || typeof item !== 'object')) throw new Error('快照行不正确')
            }
          }
        }
      }
      return value as CollectRecords
    }, () => ({}), logError)
    this.prune()
  }

  latest(): CollectRecords { this.prune(); return this.withSecurity() }

  run(hostId: string): Promise<CollectRecord> {
    if (this.stopped) return Promise.reject(new Error('采集服务已停止'))
    if (!this.options.hosts().some((host) => host.id === hostId)) return Promise.reject(new Error('主机不存在'))
    const existing = this.pending.get(hostId)
    if (!existing) return this.start(hostId, 'allow').record
    if (existing.interaction === 'forbid' && !existing.foreground) {
      existing.foreground = true
      existing.record = existing.result.then(result => {
        // An explicit refresh retains the normal authentication flow even if a
        // background attempt got there first. Do not retry network failures.
        if (result.status === 'needs-attention' && result.reason !== 'locked' && !this.stopped &&
          this.options.hosts().some(host => host.id === hostId)) return this.run(hostId)
        return result.record
      })
    }
    return existing.record
  }

  async runConnected(hostId: string): Promise<CollectRecord> {
    if (!this.options.pool.isOpen(hostId)) throw new Error('连接已断开')
    return (await this.runBackground(hostId)).record
  }

  runBackground(hostId: string): Promise<BackgroundCollection> {
    if (this.stopped) return Promise.resolve(this.unavailable(hostId, 'stopped'))
    if (!this.options.hosts().some(host => host.id === hostId)) return Promise.resolve(this.unavailable(hostId, 'collection'))
    const existing = this.pending.get(hostId)
    if (existing) {
      // Do not wait on a foreground fingerprint/keyboard dialog while hidden.
      if (existing.interaction === 'allow' && !this.options.pool.isOpen(hostId)) {
        return Promise.resolve({ ...this.unavailable(hostId, 'authentication'), status: 'needs-attention', attemptId: `${existing.attemptId}:interaction` })
      }
      return existing.result
    }
    return this.start(hostId, 'forbid').result
  }

  private unavailable(hostId: string, reason: BackgroundCollection['reason']): BackgroundCollection {
    return { status: 'unavailable', reason, attemptId: randomUUID(), at: Date.now(), record: structuredClone(this.records[hostId] ?? { snapshot: null, error: null, updatedAt: null }) }
  }

  private start(hostId: string, interaction: 'allow' | 'forbid', scheduled = false): PendingCollection {
    const controller = new AbortController(), attemptId = randomUUID()
    this.controllers.set(hostId, controller)
    let status: BackgroundCollection['status'] = 'success', reason: BackgroundCollection['reason']
    // Reserve once; both manual and extension consumers share this exact attempt.
    const lease = this.options.pool.acquire(hostId, { signal: controller.signal, ...(interaction === 'forbid' ? { interaction } : {}) })
    const task = (async () => {
      let row: CollectRecord
      try {
        const owned = await lease
        let retained = false
        try {
          const snapshot = await (this.options.collect ?? collectHost)({
            exec: (_id, script, options) => execOnClient(owned.client, script, { ...options, signal: controller.signal })
          }, hostId)
          row = { snapshot, error: null, updatedAt: snapshot.collectedAt }
          if (!controller.signal.aborted && this.autoHosts().includes(hostId) && this.options.pool.isOpen(hostId) && this.retained.get(hostId)?.lease.client !== owned.client) {
            this.releaseRetained(hostId)
            this.retained.set(hostId, { lease: owned, unsubscribe: owned.onDrop(() => this.releaseRetained(hostId)) })
            retained = true
          }
        } finally { if (!retained) owned.release() }
      } catch (error) {
        const failure = sshFailureReason(error)
        if (controller.signal.aborted) { status = 'unavailable'; reason = 'stopped' }
        else if (error instanceof Error && error.name === 'LockedError') { status = 'needs-attention'; reason = 'locked' }
        else if (failure === 'authentication' || failure === 'host-key') { status = 'needs-attention'; reason = failure }
        else if (failure === 'connection' || error instanceof Error && (error.message === '连接已断开' || /^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)$/.test((error as NodeJS.ErrnoException).code ?? ''))) { status = 'connection-failed'; reason = 'connection' }
        else { status = 'unavailable'; reason = 'collection' }
        row = {
          snapshot: this.records[hostId]?.snapshot ?? null, updatedAt: this.records[hostId]?.updatedAt ?? null,
          error: error instanceof Error ? error.message : String(error),
          ...(status === 'needs-attention' ? { needsAttention: true } : {})
        }
      }
      if (!controller.signal.aborted && this.controllers.get(hostId) === controller && this.options.hosts().some((host) => host.id === hostId)) {
        const at = Date.now()
        this.attempted.set(hostId, at)
        if (scheduled && status === 'connection-failed') {
          const failures = Math.min((this.retry.get(hostId)?.failures ?? 0) + 1, 4)
          this.retry.set(hostId, { failures, at: at + Math.min(5 * 2 ** (failures - 1), 30) * 60_000 })
        } else if (status === 'success' || scheduled) this.retry.delete(hostId)
        this.records[hostId] = row
        this.publish()
      } else {
        status = 'unavailable'; reason = this.stopped || controller.signal.aborted ? 'stopped' : 'collection'
        // The original caller may still be awaiting this attempt. Do not return
        // retired target evidence merely because it was kept out of the cache.
        row = { snapshot: null, updatedAt: null, error: null }
      }
      return row
    })().finally(() => {
      // A retired target's completion must not clear a newer collection.
      if (this.controllers.get(hostId) === controller) {
        this.pending.delete(hostId)
        this.controllers.delete(hostId)
        this.schedule()
      }
    })
    const result: Promise<BackgroundCollection> = task.then(record => ({ status, ...(reason ? { reason } : {}), attemptId, at: Date.now(), record: structuredClone(record) }),
      () => ({ ...this.unavailable(hostId, 'collection'), attemptId }))
    const entry = { interaction, attemptId, foreground: interaction === 'allow', scheduled, record: task, result }
    this.pending.set(hostId, entry)
    return entry
  }

  setWindowOpen(open: boolean): void {
    this.windowOpen = open
    this.settingsChanged()
  }

  setOverviewOpen(open: boolean): void {
    this.overviewOpen = open
    this.schedule()
  }

  settingsChanged(): void {
    const ids = new Set(this.autoHosts())
    for (const id of this.retained.keys()) if (!ids.has(id)) this.releaseRetained(id)
    for (const [id, entry] of this.pending) {
      if (entry.scheduled && !entry.foreground && !ids.has(id)) this.controllers.get(id)?.abort()
    }
    this.schedule()
  }

  private autoHosts(): string[] {
    if (this.stopped || !this.windowOpen || this.options.preferences?.().autoCollect === false) return []
    const limit = typeof this.options.overviewHostLimit === 'function' ? this.options.overviewHostLimit() : this.options.overviewHostLimit
    return this.options.hosts().slice(0, limit).map(host => host.id)
  }

  private releaseRetained(id: string): void {
    const entry = this.retained.get(id)
    if (!entry) return
    this.retained.delete(id)
    entry.unsubscribe()
    entry.lease.release()
  }

  private schedule(): void {
    clearTimeout(this.timer)
    const now = Date.now()
    const configured = (this.options.preferences?.().collectionIntervalMinutes ?? 5) * 60_000
    const interval = this.overviewOpen ? Math.min(configured, 60_000) : configured
    const due = this.autoHosts().flatMap(id => {
      if (this.pending.has(id) || (this.records[id]?.needsAttention && !this.options.pool.isOpen(id))) return []
      const lastAttempt = this.attempted.get(id) ?? this.records[id]?.updatedAt
      const at = this.retry.get(id)?.at ?? (lastAttempt == null || lastAttempt > now + 60_000 ? now : lastAttempt + interval)
      return [{ id, at }]
    })
    if (!due.length) return
    this.timer = setTimeout(() => {
      for (const { id, at } of due) {
        if (at <= Date.now() && !this.pending.has(id)) void this.start(id, 'forbid', true).record.catch(error => logError('自动采集失败', error))
      }
      this.schedule()
    }, Math.max(0, Math.min(...due.map(({ at }) => at)) - now))
    this.timer.unref?.()
  }

  prune(): void {
    const ids = new Set(this.options.hosts().map((host) => host.id))
    for (const id of new Set([...this.controllers.keys(), ...this.attempted.keys(), ...this.retained.keys()])) if (!ids.has(id)) this.retire(id)
    const removed = Object.keys(this.records).filter((id) => !ids.has(id))
    for (const id of removed) delete this.records[id]
    if (removed.length) this.publish()
  }

  /** Connection edits retire cached evidence as well as the in-flight collector. */
  invalidate(hostId: string): void {
    this.retire(hostId)
    delete this.records[hostId]
    this.publish()
    this.schedule()
  }

  private retire(hostId: string): void {
    this.releaseRetained(hostId)
    this.attempted.delete(hostId)
    this.retry.delete(hostId)
    this.controllers.get(hostId)?.abort()
    this.controllers.delete(hostId); this.pending.delete(hostId)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    for (const id of this.retained.keys()) this.releaseRetained(id)
    for (const controller of this.controllers.values()) controller.abort()
  }

  securityUpdated(): void { this.publish() }
  private withSecurity(): CollectRecords {
    const records = structuredClone(this.records)
    if (this.options.securityScore) for (const [id, row] of Object.entries(records)) {
      row.securityScore = this.options.securityScore(id)
      if (row.snapshot) row.snapshot.securityScore = row.securityScore
    }
    return records
  }
  private publish(): void {
    try { writeJsonFile(this.options.filePath, this.records) }
    catch (error) { logError('快照保存失败', error); throw error }
    finally { this.options.updated(this.withSecurity()) }
  }
}
