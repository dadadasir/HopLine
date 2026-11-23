import { describe, expect, it } from 'vitest'
import { billingSummary, convertMinor, effectiveRenewAt, renewalStatus } from '../src/core/billing'
import { currencyCode, displayCurrency, secondaryCurrency } from '../src/core/currency'
import { DEFAULT_FX } from '../src/core/fx-defaults'
import { emptyHostMeta, pricedHostMeta, recoverHostMeta } from '../src/core/host-meta'
import { emptyStore, MemorySecretCodec, Vault } from '../src/core/vault'
import { migrateStore } from '../src/core/vault-migrate'
import { money } from '../src/renderer/src/logic/overview'
import type { FxSnapshot } from '../src/shared/fx'
const rates: FxSnapshot = { date: '2026-11-18', base: 'EUR', rates: { EUR: 1, USD: 1.25, CNY: 8, JPY: 160 }, source: 'ecb', fetchedAt: 1 }
const host = (currency: string, price: number, cycle: 'monthly' | 'quarterly' | 'yearly' = 'monthly') => {
  const vault = new Vault(emptyStore(), new MemorySecretCodec())
  return vault.saveHost({ name: currency, host: '127.0.0.1', port: 22, username: 'test', authType: 'password', groupId: null, meta: { price, currency, billingCycle: cycle } })
}
describe('simple currency billing', () => {
  it('uses the supplied ECB defaults offline and cached rates instead when present', () => {
    expect(DEFAULT_FX.date).toBe('2026-11-18'); expect(Object.keys(DEFAULT_FX.rates)).toHaveLength(30)
    expect(convertMinor(100, 'USD', 'CNY')).toBeCloseTo(666.7, 1)
    expect(convertMinor(10000, 'EUR', 'CNY', rates)).toBe(80000)
    expect(convertMinor(12500, 'USD', 'CNY', rates)).toBe(80000)
    expect(convertMinor(80000, 'CNY', 'USD', rates)).toBe(12500)
    expect(convertMinor(123, 'JPY', 'JPY')).toBe(123)
    expect(convertMinor(10000, 'KHR', 'CNY')).toBeNull()
    expect(convertMinor(100.5, 'USD', 'CNY')).toBeNull()
    expect(convertMinor(100, 'USD', 'CNY', { ...rates, rates: { EUR: 1, USD: 1 } })).toBeNull()
  })
  it('keeps fractional cents until currency-specific display rounding', () => {
    const amount = convertMinor(100, 'USD', 'CNY', { ...rates, rates: { USD: 1, CNY: 1.005 } })!
    expect(amount).toBe(100.5); expect(money(amount, 'CNY', 'en')).toContain('1.01')
    expect(money(123456, 'JPY', 'en')).toBe('¥1,235')
    const summary = billingSummary(Array.from({ length: 3 }, () => host('USD', 100, 'quarterly')), 'USD', null, 0)
    expect(summary.monthly).toBe(100); expect(summary.yearly).toBe(1200)
  })
  it('counts all hosts, excludes unsupported currencies and flags incomplete legacy costs', () => {
    const hosts = [...Array.from({ length: 7 }, () => host('USD', 12500)), host('CNY', 800), host('KHR', 900)]
    const incomplete = { ...host('CNY', 100), meta: { ...emptyHostMeta(), price: 100 } }
    const summary = billingSummary([...hosts, incomplete], 'CNY', rates, 0)
    expect(summary.rows).toHaveLength(10); expect(summary.monthly).toBe(560800); expect(summary.excluded).toBe(1)
    expect(summary.rows.at(-1)).toMatchObject({ incomplete: true, converted: null, monthly: null })
    expect(billingSummary([host('KHR', 900)], 'CNY', null, 0)).toMatchObject({ monthly: 0, yearly: 0, excluded: 1 })
    expect(billingSummary([], 'CNY', null, 0).monthly).toBeNull()
  })
  it('swaps main and secondary currencies without rounding the monthly total', () => {
    expect(displayCurrency('auto', 'zh')).toBe('CNY'); expect(displayCurrency('auto', 'en')).toBe('USD')
    expect(displayCurrency('USD', 'zh')).toBe('USD'); expect(displayCurrency('CNY', 'en')).toBe('CNY')
    expect(displayCurrency('JPY', 'zh')).toBe('CNY')
    expect(secondaryCurrency('USD')).toBe('CNY'); expect(secondaryCurrency('CNY')).toBe('USD')
    const hosts = [host('USD', 12000, 'yearly')]
    const cny = billingSummary(hosts, 'CNY', rates, 0), usd = billingSummary(hosts, 'USD', rates, 0)
    expect(cny.monthly).toBe(6400); expect(usd.monthly).toBe(1000)
  })
})
describe('legacy settings and asset validation', () => {
  it('accepts ISO currencies and RMB while validating only actual pricing edits', () => {
    expect(currencyCode(' rmb ')).toBe('CNY'); expect(() => currencyCode('QQQ')).toThrow('ISO')
    expect(() => pricedHostMeta(emptyHostMeta(), { price: 0 })).toThrow('同时填写')
    const old = { ...emptyHostMeta(), price: 100 }
    expect(pricedHostMeta(old, { ...old, note: 'new note' }).price).toBe(100)
    expect(() => pricedHostMeta(old, { price: 200 })).toThrow('同时填写')
    expect(recoverHostMeta({ provider: 'Legacy', price: 100, currency: 'QQQ', note: 'keep' })).toMatchObject({ price: 100, currency: null, note: 'keep' })
  })
  it('allows old hosts to be renamed or have connection/init settings saved without fixing legacy billing', () => {
    const data = emptyStore(), source = new Vault(data, new MemorySecretCodec())
    const saved = source.saveHost({ ...host('USD', 100), id: undefined })
    const legacy = source.snapshot(); legacy.hosts[0]!.meta.currency = null; legacy.hosts[0]!.meta.billingCycle = null
    const vault = new Vault(legacy, new MemorySecretCodec()), current = vault.listHosts()[0]!
    expect(vault.saveHost({ ...current, name: 'Renamed' }).name).toBe('Renamed')
    expect(vault.saveHost({ ...vault.listHosts()[0]!, port: 2222, connectionTimeoutSec: 30 }).port).toBe(2222)
    expect(vault.saveHost({ ...vault.listHosts()[0]!, username: 'initialized', privateKeyPath: '/tmp/fixture-key' }).username).toBe('initialized')
    expect(() => vault.saveHost({ ...vault.listHosts()[0]!, meta: { price: 200 } })).toThrow('同时填写')
    expect(vault.getHost(saved.id)?.meta.price).toBe(100)
  })
  it('ignores retired settings even when malformed, including old backups', () => {
    const old = emptyStore() as any
    old.settings.displayCurrency = 'JPY'; old.settings.automaticFx = { invalid: true }; old.settings.manualFxRates = 'invalid'
    const migrated = migrateStore(old).data, vault = new Vault(migrated, new MemorySecretCodec())
    expect(vault.settingsPublic(false).displayCurrency).toBe('auto')
    expect(vault.snapshot().settings).not.toHaveProperty('automaticFx'); expect(vault.snapshot().settings).not.toHaveProperty('manualFxRates')
    vault.updateSettings({ displayCurrency: 'CNY' })
    const backup = vault.exportPortable(); Object.assign(backup.settings, { automaticFx: 123, manualFxRates: { invalid: false } })
    const restored = new Vault(emptyStore(), new MemorySecretCodec()); restored.importPortable(backup, 'replace')
    expect(restored.settingsPublic(false).displayCurrency).toBe('CNY')
    expect(restored.exportPortable().settings).not.toHaveProperty('manualFxRates')
    expect(old.settings.manualFxRates).toBe('invalid')
  })
})
describe('renewal calendar rules', () => {
  it('counts the whole renewal day as soon, with overdue starting the following local day', () => {
    const due = new Date(2026, 0, 31).getTime()
    expect(renewalStatus(due, new Date(2026, 0, 31, 23, 59).getTime())).toBe('soon')
    expect(renewalStatus(due, new Date(2026, 1, 1).getTime())).toBe('overdue')
    expect(renewalStatus(due + 15 * 86400000, due)).toBe('soon')
    expect(renewalStatus(due + 16 * 86400000, due)).toBe('normal')
  })
  it('advances overdue periods through today with the original month-end anchor, across repeated saves', () => {
    const meta = { ...emptyHostMeta(), billingCycle: 'monthly' as const, renewAt: new Date(2026, 0, 31).getTime() }
    expect(effectiveRenewAt(meta, new Date(2026, 2, 1).getTime())).toBe(new Date(2026, 2, 31).getTime())
    const feb = effectiveRenewAt(meta, new Date(2026, 1, 1).getTime())!
    const saved = pricedHostMeta(meta, { renewAt: feb, renewalAnchorDay: 31 })
    expect(effectiveRenewAt(saved, new Date(2026, 2, 1).getTime())).toBe(new Date(2026, 2, 31).getTime())
    expect(effectiveRenewAt(meta, new Date(2026, 2, 31).getTime())).toBe(new Date(2026, 2, 31).getTime())
    expect(effectiveRenewAt({ ...meta, billingCycle: 'quarterly' }, new Date(2026, 5, 1).getTime())).toBe(new Date(2026, 6, 31).getTime())
    expect(effectiveRenewAt({ ...meta, billingCycle: 'yearly', renewAt: new Date(2024, 1, 29).getTime() }, new Date(2027, 2, 1).getTime())).toBe(new Date(2028, 1, 29).getTime())
    expect(effectiveRenewAt({ ...meta, billingCycle: 'once' }, new Date(2026, 2, 1).getTime())).toBe(meta.renewAt)
    expect(pricedHostMeta(saved, { renewAt: new Date(2026, 3, 10).getTime() })).not.toHaveProperty('renewalAnchorDay')
  })
})
