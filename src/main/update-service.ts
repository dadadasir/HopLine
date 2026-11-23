import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { readJsonFile, writeJsonFile } from '../core/json-file'
import { parseLatestRelease } from '../core/updates'
import type { UpdateCheckResult, UpdateErrorReason, UpdatePreferences, UpdateRelease } from '../shared/updates'

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_STARTUP_DELAY_MS = 30_000
export const UPDATE_TIMEOUT_MS = 10_000
export const UPDATE_RESPONSE_LIMIT = 256 * 1024
export const UPDATE_ENDPOINT = 'https://api.github.com/repos/dadadasir/HopLine/releases/latest'

class UpdateRequestError extends Error {
  constructor(readonly reason: UpdateErrorReason) { super(reason) }
}

/** Fixed public endpoint, no cookies, credentials, redirects or device-specific headers. */
export function requestLatestRelease(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: UpdateRequestError | null, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve(value)
    }
    const request = https.get(UPDATE_ENDPOINT, {
      signal, agent: false,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HopLine' }
    }, (response) => {
      const status = response.statusCode
      if (status !== 200) {
        finish(new UpdateRequestError(status === 403 || status === 429 ? 'rate-limit' : status === 404 ? 'unavailable' : 'network'))
        response.destroy()
        return
      }
      if (!/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(response.headers['content-type'] ?? '') ||
        Number(response.headers['content-length']) > UPDATE_RESPONSE_LIMIT) {
        finish(new UpdateRequestError('invalid')); response.destroy(); return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > UPDATE_RESPONSE_LIMIT) {
          finish(new UpdateRequestError('invalid')); response.destroy(); return
        }
        chunks.push(chunk)
      })
      response.on('error', () => finish(new UpdateRequestError('network')))
      response.on('aborted', () => finish(new UpdateRequestError('network')))
      response.on('end', () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { finish(new UpdateRequestError('invalid')) }
      })
    })
    const timer = setTimeout(() => {
      finish(new UpdateRequestError('timeout'))
      request.destroy()
    }, UPDATE_TIMEOUT_MS)
    timer.unref?.()
    request.on('error', () => finish(new UpdateRequestError('network')))
  })
}

interface UpdateOptions {
  request?: (signal: AbortSignal) => Promise<unknown>
  now?: () => number
  onAvailable?: (release: UpdateRelease) => void
  startupDelayMs?: number
}

interface PendingCheck {
  controller: AbortController
  manual: boolean
  promise: Promise<UpdateCheckResult | null>
}

export class UpdateService {
  private readonly file: string
  private readonly now: () => number
  private readonly request: (signal: AbortSignal) => Promise<unknown>
  private value: UpdatePreferences
  private pending: PendingCheck | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopped = false
  private storageReadable = true

  constructor(userData: string, private readonly currentVersion: string, private readonly options: UpdateOptions = {}) {
    this.file = path.join(userData, 'updates.json')
    this.now = options.now ?? Date.now
    this.request = options.request ?? requestLatestRelease
    const existed = fs.existsSync(this.file)
    try {
      let recovered = false
      if (!existed) {
        try { recovered = fs.readdirSync(userData).some(name => /^updates\.corrupt-\d{14}(?:-\d+)?\.json$/.test(name)) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      this.value = readJsonFile(this.file, (raw) => {
        const value = raw as Partial<UpdatePreferences> | null
        if (!value || typeof value.automatic !== 'boolean' || (value.lastAttemptAt !== null &&
          (typeof value.lastAttemptAt !== 'number' || !Number.isSafeInteger(value.lastAttemptAt) || value.lastAttemptAt < 0))) throw new Error('Invalid update preferences')
        return { automatic: value.automatic, lastAttemptAt: value.lastAttemptAt }
      }, () => ({ automatic: !existed && !recovered, lastAttemptAt: null }), () => undefined)
      // Quarantine removes the original path. Persist the disabled recovery
      // state so a subsequent launch cannot mistake it for a fresh install.
      // The preserved corrupt file also keeps this fail-closed rule effective
      // if writing the replacement fails and the application restarts.
      if ((existed || recovered) && !fs.existsSync(this.file)) writeJsonFile(this.file, this.value)
    } catch {
      // An unreadable preference must not silently turn a previous opt-out on.
      this.value = { automatic: false, lastAttemptAt: null }
      this.storageReadable = false
    }
  }

  preferences(): UpdatePreferences { return { ...this.value } }

  setAutomatic(automatic: boolean): UpdatePreferences {
    if (typeof automatic !== 'boolean') throw new Error('updates.error.invalid')
    if (!this.storageReadable) throw new Error('updates.error.storage')
    const next = { ...this.value, automatic }
    try { writeJsonFile(this.file, next) } catch { throw new Error('updates.error.storage') }
    this.value = next
    if (!automatic && this.pending && !this.pending.manual) {
      this.pending.controller.abort()
      this.pending = null
    }
    this.schedule(this.options.startupDelayMs ?? UPDATE_STARTUP_DELAY_MS)
    return this.preferences()
  }

  start(): void {
    if (this.running || this.stopped) return
    this.running = true
    this.schedule(this.options.startupDelayMs ?? UPDATE_STARTUP_DELAY_MS)
  }

  stop(): void {
    this.stopped = true
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending?.controller.abort()
  }

  async check(manual: boolean): Promise<UpdateCheckResult | null> {
    if (this.stopped) return null
    if (!this.storageReadable) return manual ? { status: 'error', reason: 'storage' } : null
    if (!manual && !this.value.automatic) return null
    if (this.pending) {
      this.pending.manual ||= manual
      return this.pending.promise
    }
    const now = this.now()
    if (!manual && this.value.lastAttemptAt !== null && now - this.value.lastAttemptAt < UPDATE_INTERVAL_MS) return null
    const next = { ...this.value, lastAttemptAt: now }
    try { writeJsonFile(this.file, next) }
    catch { return manual ? { status: 'error', reason: 'storage' } : null }
    this.value = next
    const pending: PendingCheck = { controller: new AbortController(), manual, promise: Promise.resolve(null) }
    this.pending = pending
    pending.promise = this.perform(pending)
    try { return await pending.promise }
    finally {
      if (this.pending === pending) this.pending = null
      this.schedule()
    }
  }

  private async perform(pending: PendingCheck): Promise<UpdateCheckResult | null> {
    let result: UpdateCheckResult
    try { result = parseLatestRelease(await this.request(pending.controller.signal), this.currentVersion) }
    catch (error) { result = { status: 'error', reason: error instanceof UpdateRequestError ? error.reason : 'network' } }
    if (this.stopped || pending.controller.signal.aborted || (!pending.manual && !this.value.automatic)) return null
    if (!pending.manual) {
      if (result.status === 'available') {
        try { this.options.onAvailable?.(result.release) } catch { /* Window delivery must not break the automatic scheduler. */ }
      }
      return result.status === 'error' ? null : result
    }
    return result
  }

  private schedule(minimumDelay = UPDATE_INTERVAL_MS): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.running || this.stopped || !this.value.automatic) return
    const remaining = this.value.lastAttemptAt === null ? 0 : this.value.lastAttemptAt + UPDATE_INTERVAL_MS - this.now()
    // Bound timer delays if the system clock moves backwards, preserving the
    // persisted daily limit without overflowing Node's signed 32-bit timeout.
    const delay = Math.min(Math.max(minimumDelay, remaining, 1000), UPDATE_INTERVAL_MS)
    this.timer = setTimeout(() => { this.timer = null; void this.check(false).finally(() => this.schedule()) }, delay)
    this.timer.unref?.()
  }
}
