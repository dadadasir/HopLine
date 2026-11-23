import type { Locale } from '../shared/types'

export const CURRENCIES = Intl.supportedValuesOf('currency')
const codes = new Set(CURRENCIES)

export function currencyCode(value: unknown): string {
  if (typeof value !== 'string') throw new Error('币种必须是有效的 ISO 货币代码')
  const code = value.trim().toUpperCase() === 'RMB' ? 'CNY' : value.trim()
  if (!codes.has(code)) throw new Error('币种必须是有效的 ISO 货币代码')
  return code
}

export function normalizeDisplayCurrency(value: unknown): 'auto' | 'CNY' | 'USD' {
  return value === 'CNY' || value === 'RMB' ? 'CNY' : value === 'USD' ? 'USD' : 'auto'
}

export function displayCurrency(value: string | undefined, locale: Locale): 'CNY' | 'USD' {
  const code = normalizeDisplayCurrency(value)
  return code === 'auto' ? locale === 'zh' ? 'CNY' : 'USD' : code
}

export function secondaryCurrency(primary: string): 'CNY' | 'USD' {
  return primary === 'CNY' ? 'USD' : 'CNY'
}
