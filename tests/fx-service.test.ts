import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FxService, FX_INTERVAL_MS, parseFxRates } from '../src/main/fx-service'
import { emptyHostMeta } from '../src/core/host-meta'
import { DEFAULT_FX } from '../src/core/fx-defaults'
import type { HostPublic, SettingsPublic } from '../src/shared/types'
vi.mock('electron', () => ({ net: { request: vi.fn() } }))
const rows = [{ date: '2026-11-19', base: 'EUR', quote: 'USD', rate: 1.1 }, { date: '2026-11-19', base: 'EUR', quote: 'CNY', rate: 8 }]
let directory: string
let context: { hosts: Pick<HostPublic, 'meta'>[]; settings: Pick<SettingsPublic, 'language' | 'displayCurrency'> }
const services: FxService[] = []
const make = (options: Partial<ConstructorParameters<typeof FxService>[1]> = {}) => {
  const service = new FxService(directory, { context: () => context, ...options }); services.push(service); return service
}
beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 19) })
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hopline-fx-simple-'))
  context = { hosts: [{ meta: { ...emptyHostMeta(), currency: 'USD', price: 100 } }], settings: { language: 'zh', displayCurrency: 'auto' } }
})
afterEach(() => { services.splice(0).forEach(service => service.stop()); vi.restoreAllMocks(); vi.useRealTimers(); fs.rmSync(directory, { recursive: true, force: true }) })
it('uses bundled rates before startup, then replaces them with a cached snapshot on success', async () => {
  const changed = vi.fn(), request = vi.fn(async () => rows), service = make({ request, onChanged: changed })
  expect(service.read()).toEqual(DEFAULT_FX)
  const copy = service.read(); copy.rates.CNY = 999
  expect(service.read().rates.CNY).toBe(7.3126)
  service.start(); service.start()
  await vi.advanceTimersByTimeAsync(29_999); expect(request).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce()
  expect(service.read()).toMatchObject({ date: '2026-11-19', rates: { CNY: 8, USD: 1.1, EUR: 1 } })
  expect(make().read()).toEqual(service.read())
})
it('checks any priced host daily, including same-currency totals converted to the secondary currency', async () => {
  const request = vi.fn(async () => rows), service = make({ request })
  context.hosts[0]!.meta.price = null; service.start()
  await vi.advanceTimersByTimeAsync(30_000); expect(request).not.toHaveBeenCalled()
  context.hosts[0]!.meta = { ...emptyHostMeta(), price: 0, currency: 'CNY' }
  await vi.advanceTimersByTimeAsync(FX_INTERVAL_MS); expect(request).toHaveBeenCalledOnce()
  context.settings.language = 'en'
  await vi.advanceTimersByTimeAsync(FX_INTERVAL_MS); expect(request).toHaveBeenCalledTimes(2)
  context.hosts[0]!.meta.currency = null
  await vi.advanceTimersByTimeAsync(FX_INTERVAL_MS); expect(request).toHaveBeenCalledTimes(3)
  context.hosts = []
  await vi.advanceTimersByTimeAsync(FX_INTERVAL_MS); expect(request).toHaveBeenCalledTimes(3)
})
it('keeps cached bytes, visible rates and notifications unchanged on failure without an immediate retry', async () => {
  const request = vi.fn().mockResolvedValueOnce(rows).mockRejectedValue(new Error('private transport detail')), changed = vi.fn()
  const service = make({ request, onChanged: changed }); service.start()
  await vi.advanceTimersByTimeAsync(30_000)
  const previous = service.read(), bytes = fs.readFileSync(path.join(directory, 'fx-rates.json'), 'utf8')
  await vi.advanceTimersByTimeAsync(FX_INTERVAL_MS)
  expect(service.read()).toEqual(previous)
  expect(fs.readFileSync(path.join(directory, 'fx-rates.json'), 'utf8')).toBe(bytes)
  expect(changed).toHaveBeenCalledOnce()
  service.stop(); const restarted = make({ request, onChanged: changed }); restarted.start()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(request).toHaveBeenCalledTimes(2)
  expect(restarted.read()).toEqual(previous)
})
it('silently retains defaults when the first request fails or the cache is malformed', async () => {
  fs.writeFileSync(path.join(directory, 'fx-rates.json'), '{broken')
  const changed = vi.fn(), service = make({ request: async () => { throw Error('offline') }, onChanged: changed })
  service.start(); await vi.advanceTimersByTimeAsync(30_000)
  expect(service.read()).toEqual(DEFAULT_FX)
  expect(changed).not.toHaveBeenCalled()
  expect(fs.readFileSync(path.join(directory, 'fx-rates.json'), 'utf8')).toBe('{broken')
})
it('accepts the previous cache envelope and ignores its retired state', () => {
  const snapshot = parseFxRates(rows, Date.now())
  fs.writeFileSync(path.join(directory, 'fx-rates.json'), JSON.stringify({ snapshot, lastAttemptAt: 'ignored', status: 'error' }))
  expect(make().read()).toEqual(snapshot)
})
it('does not publish or replace rates when cache persistence fails', async () => {
  const changed = vi.fn(), service = make({ request: async () => rows, onChanged: changed })
  fs.mkdirSync(path.join(directory, 'fx-rates.json'))
  service.start(); await vi.advanceTimersByTimeAsync(30_000)
  expect(service.read()).toEqual(DEFAULT_FX); expect(changed).not.toHaveBeenCalled()
})
it('stops the timer and ignores an in-flight result after shutdown', async () => {
  let resolve!: (value: unknown) => void
  const changed = vi.fn(), request = vi.fn(() => new Promise(done => { resolve = done })), service = make({ request, onChanged: changed })
  service.start(); await vi.advanceTimersByTimeAsync(30_000)
  service.stop(); resolve(rows); await vi.advanceTimersByTimeAsync(FX_INTERVAL_MS * 2)
  expect(request).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled()
  expect(service.read()).toEqual(DEFAULT_FX)
})
it.each([{}, [], [{ ...rows[0], rate: 0 }], [{ ...rows[0], quote: 'QQQ' }], [{ ...rows[0], base: 'USD' }], [{ ...rows[0], date: '2026-02-31' }]])('rejects invalid rate payloads', raw => {
  expect(() => parseFxRates(raw, Date.now())).toThrow()
})
