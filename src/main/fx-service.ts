import fs from 'node:fs'
import path from 'node:path'
import { net } from 'electron'
import { writeJsonFile } from '../core/json-file'
import { currencyCode } from '../core/currency'
import { DEFAULT_FX } from '../core/fx-defaults'
import { FX_INTERVAL_MS, type FxSnapshot } from '../shared/fx'
import type { HostPublic, SettingsPublic } from '../shared/types'
export { FX_INTERVAL_MS } from '../shared/fx'

export const FX_ENDPOINT = 'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR'
export const FX_TIMEOUT_MS = 10_000
export const FX_RESPONSE_LIMIT = 256 * 1024

/** Chromium networking follows system proxies; no session cookies or redirects. */
export function requestFxRates(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url: FX_ENDPOINT, credentials: 'omit', useSessionCookies: false,
      redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } })
    let settled = false
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) { reject(error); request.abort() } else resolve(value)
    }
    const abort = () => finish(new Error('aborted'))
    const timer = setTimeout(() => finish(new Error('timeout')), FX_TIMEOUT_MS)
    timer.unref?.()
    request.on('error', () => finish(new Error('network')))
    request.on('abort', abort)
    request.on('close', () => { if (!settled) finish(new Error('network')) })
    request.on('redirect', () => finish(new Error('redirect')))
    request.on('login', (_info, callback) => callback())
    request.on('response', response => {
      const header = (name: string) => { const value = response.headers[name]; return Array.isArray(value) ? value.join(';') : value ?? '' }
      if (response.statusCode !== 200 || !/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(header('content-type')) || Number(header('content-length')) > FX_RESPONSE_LIMIT) {
        finish(new Error('invalid')); return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > FX_RESPONSE_LIMIT) { finish(new Error('invalid')); return }
        chunks.push(chunk)
      })
      response.on('error', () => finish(new Error('network')))
      response.on('aborted', () => finish(new Error('network')))
      response.on('end', () => {
        try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { finish(new Error('invalid')) }
      })
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else request.end()
  })
}

export function parseFxRates(raw: unknown, fetchedAt: number): FxSnapshot {
  if (!Array.isArray(raw) || !raw.length || raw.length > 256) throw new Error('invalid')
  const rates: Record<string, number> = { EUR: 1 }
  let date = ''
  for (const row of raw) {
    if (!row || row.base !== 'EUR' || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date ||
      typeof row.rate !== 'number' || !Number.isFinite(row.rate) || row.rate <= 0 || row.rate > 1e12) throw new Error('invalid')
    const quote = currencyCode(row.quote)
    if ((date && row.date !== date) || (quote === 'EUR' ? row.rate !== 1 : Object.hasOwn(rates, quote))) throw new Error('invalid')
    date = row.date; rates[quote] = row.rate
  }
  return { date, base: 'EUR', rates, source: 'ecb', fetchedAt }
}

interface FxOptions {
  context: () => { hosts: Pick<HostPublic, 'meta'>[]; settings: Pick<SettingsPublic, 'language' | 'displayCurrency'> }
  request?: (signal: AbortSignal) => Promise<unknown>
  now?: () => number
  onChanged?: (snapshot: FxSnapshot) => void
}

export class FxService {
  private readonly file: string
  private readonly checkFile: string
  private value: FxSnapshot = structuredClone(DEFAULT_FX)
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined

  constructor(userData: string, private readonly options: FxOptions) {
    this.file = path.join(userData, 'fx-rates.json')
    this.checkFile = path.join(userData, 'fx-last-check.json')
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const cached = raw.snapshot ?? raw // Read the previous cache envelope without its retired UI state.
      if (cached.base !== 'EUR' || cached.source !== 'ecb' || !Number.isSafeInteger(cached.fetchedAt) || cached.fetchedAt < 0) return
      this.value = parseFxRates(Object.entries(cached.rates).map(([quote, rate]) => ({ date: cached.date, base: cached.base, quote, rate })), cached.fetchedAt)
    } catch { /* Missing or invalid cache simply uses the bundled rates. */ }
  }

  read(): FxSnapshot { return structuredClone(this.value) }
  start(): void { if (!this.timer) this.schedule(30_000) }
  stop(): void { clearTimeout(this.timer); this.timer = undefined; this.controller?.abort() }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => { this.schedule(FX_INTERVAL_MS); void this.check() }, delay)
    this.timer.unref?.()
  }
  private async check(): Promise<void> {
    const { hosts } = this.options.context()
    // The overview also converts a same-currency total to its secondary currency.
    if (!hosts.some(host => host.meta.price !== null)) return
    const now = this.options.now?.() ?? Date.now()
    try {
      // A private timestamp prevents restarts from adding requests; no UI state or rate-cache mutation on failure.
      let previous = 0
      try { previous = JSON.parse(fs.readFileSync(this.checkFile, 'utf8')) } catch { /* First daily check. */ }
      if (Number.isFinite(previous) && previous > 0 && now - previous < FX_INTERVAL_MS) return
      writeJsonFile(this.checkFile, now)
      const controller = new AbortController()
      this.controller = controller
      const snapshot = parseFxRates(await (this.options.request ?? requestFxRates)(controller.signal), this.options.now?.() ?? Date.now())
      if (controller.signal.aborted) return
      writeJsonFile(this.file, snapshot)
      this.value = snapshot
      this.options.onChanged?.(this.read())
    } catch { /* Silent until the next daily check; preserve both visible values and cached rates. */ }
    finally { this.controller = undefined }
  }
}
